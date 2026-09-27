/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's floating-point environment, classifications and number
 * reading answer the same as their x86, input by input, on cork's test
 * machine (`scripts/guest-code/equivalence.mjs`) -- the control word left
 * and the exception flags cleared among what is compared -- and what they
 * answer is msvcrt's: the portable control bits of `float.h` for each x87
 * word, `_fpclass`'s classes, the next double by its bits, and strtod's
 * values, ends and errno for Wine's conformance cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-float.x86.js';
import * as sources from './inguest-float.js';
import { scanDecimal } from './convert.js';
import { DATA, doubleWords, equivalence, random } from
    '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-float.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-float.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double, single, extended, and each with another rounding. */
const CONTROLS = [0x27f, 0x07f, 0x37f, 0xe7f, 0x47f, 0x87f];

/** A double's two dwords. @param {number} value */
const words = value=>doubleWords(value);

/** A double from its two dwords. @param {number} low @param {number} high */
const fromWords = (low, high)=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, low, true);
    view.setUint32(4, high, true);
    return view.getFloat64(0, true);
};

/**
 * Doubles of every kind, as their dwords: zeros, denormals, normals,
 * infinities, quiet and signalling NaNs, of both signs.
 *
 * @param {() => number} next
 * @returns {[number, number]}
 */
function doubleBits(next){
    const pick = next() % 8;
    const sign = next() % 2 === 0 ? 0 : 0x80000000;
    const fraction = next() & 0xfffff;
    const low = next();
    switch (pick)
    {
        case 0: return [0, sign];
        case 1: return [low, (sign | fraction) >>> 0];
        case 2: return [0, (sign | 0x7ff00000) >>> 0];
        case 3: return [low | 1, (sign | 0x7ff80000 | fraction) >>> 0];
        case 4: return [low | 1, (sign | 0x7ff00000 | fraction & 0x7ffff) >>> 0];
        default: return [low, (sign | (1 + next() % 0x7fe) << 20 | fraction) >>> 0];
    }
}

/** The runtime's reading of an x87 control word, bit by bit. @param {number} word */
function abstract(word){
    let bits = 0;
    const exceptions = [[0x1, 0x10], [0x2, 0x80000], [0x4, 0x8], [0x8, 0x4], [0x10, 0x2],
        [0x20, 0x1]];
    for (const [x87, runtime] of exceptions)
    {
        bits |= (word & x87) !== 0 ? runtime : 0;
    }
    bits |= [0, 0x100, 0x200, 0x300][word >> 10 & 3];
    bits |= [0x20000, 0, 0x10000, 0][word >> 8 & 3];
    bits |= (word & 0x1000) !== 0 ? 0x40000 : 0;
    return bits >>> 0;
}

test('_control87 and _controlfp: the bits the mask names, loaded and read back', ()=>{
    const next = random(41);
    /** @type {[number, number][]} newControl, mask */
    const asked = [[0, 0], [0x20000, 0x30000], [0x10000, 0x30000], [0, 0x30000],
        [0x30000, 0x30000], [0x300, 0x300], [0x100, 0x300], [0x200, 0x300], [0, 0x8001f],
        [0x8001f, 0x8001f], [0x40000, 0x40000], [0xffffffff, 0], [0xffffffff, 0xffffffff],
        [0x03000000, 0x03000000], [0x80000, 0x80000]];
    for (let i = 0; i < 40; i++)
    {
        asked.push([next(), next()]);
    }
    for (const control of [...CONTROLS, 0x17f, 0x137f, 0x27e, 0x2c0])
    {
        for (const [wanted, mask] of asked)
        {
            same('_control87', { stack: [wanted, mask], control });
            same('_controlfp', { stack: [wanted, mask], control });
        }
    }
    // The answers themselves: the MSVC default, and each change as the word shows it.
    const answer = (/** @type {string} */ name, /** @type {number} */ control,
        /** @type {number[]} */ stack)=>same(name, { stack, control }).eax >>> 0;
    assert.equal(answer('_controlfp', 0x27f, [0, 0]), 0x9001f);
    assert.equal(answer('_controlfp', 0x27f, [0x20000, 0x30000]), 0xa001f, 'single precision');
    assert.equal(answer('_controlfp', 0x27f, [0x300, 0x300]), 0x9031f, 'chop');
    assert.equal(answer('_control87', 0x27f, [0, 0x80000]), 0x1001f,
        '_control87 unmasks the denormal exception');
    assert.equal(answer('_controlfp', 0x27f, [0, 0x80000]), 0x9001f, '_controlfp does not');
    for (const control of CONTROLS)
    {
        assert.equal(answer('_controlfp', control, [0, 0]), abstract(control),
            `0x${control.toString(16)} read`);
    }
});

test('_statusfp and _clearfp: the flags raised, and the flags cleared', ()=>{
    for (let flags = 0; flags < 0x40; flags++)
    {
        for (const status of [flags, flags | 0x80, flags | 0x4700])
        {
            const expected = abstract(flags) & 0x8001f;
            assert.equal(same('_statusfp', { status, control: 0x27f }).eax >>> 0, expected);
            assert.equal(same('_clearfp', { status, control: 0x27f }).eax >>> 0, expected);
        }
    }
});

test('_isnan, _finite and _fpclass read the bits of every kind of double', ()=>{
    const next = random(42);
    /** @type {Record<number, (low: number, high: number) => boolean>} */
    const classes = {
        0x1: (low, high)=>(high & 0x7ff80000) === 0x7ff00000 && ((high & 0x7ffff) | low) !== 0,
        0x2: (low, high)=>(high & 0x7ff80000) === 0x7ff80000,
        0x4: (low, high)=>high === 0xfff00000 && low === 0,
        0x200: (low, high)=>high === 0x7ff00000 && low === 0,
    };
    for (let i = 0; i < 600; i++)
    {
        const [low, high] = doubleBits(next);
        const value = fromWords(low, high);
        const nan = same('_isnan', { stack: [low, high] }).eax;
        const finite = same('_finite', { stack: [low, high] }).eax;
        const kind = same('_fpclass', { stack: [low, high] }).eax;
        assert.equal(nan, Number.isNaN(value) ? 1 : 0);
        assert.equal(finite, Number.isFinite(value) ? 1 : 0);
        const special = Object.entries(classes).find(([, is])=>is(low, high));
        const negative = high >>> 31 === 1;
        const expected = special ? Number(special[0])
            : value === 0 ? (negative ? 0x20 : 0x40)
                : Math.abs(value) < 2 ** -1022 ? (negative ? 0x10 : 0x80)
                    : negative ? 0x8 : 0x100;
        assert.equal(kind, expected, `_fpclass of 0x${high.toString(16)}:${low.toString(16)}`);
    }
});

test('_copysign, _chgsign, _logb and _nextafter', ()=>{
    const next = random(43);
    /** @type {(x: number) => number | { st0: number }} */
    const zeroLog = ()=>({ st0: -Infinity });
    for (const control of CONTROLS.slice(0, 4))
    {
        for (let i = 0; i < 150; i++)
        {
            const x = fromWords(...doubleBits(next));
            const y = fromWords(...doubleBits(next));
            same('_copysign', { stack: [...words(x), ...words(y)], control });
            same('_chgsign', { stack: words(x), control });
            same('_logb', { stack: words(x), control }, { host: ()=>zeroLog(x) });
            const toward = i % 5 === 0 ? x : i % 5 === 1 ? -y : y;
            same('_nextafter', { stack: [...words(x), ...words(toward)], control }, {
                host: (_, args)=>({ st0: fromWords(args[0], args[1]) > 0 ? Infinity
                    : -Infinity }),
            });
        }
        for (const [x, y] of [[1, 2], [1, 0], [2, 0], [-2, 0], [-1, -2], [2 ** -1022, 0],
            [5e-324, 0], [-5e-324, 1], [0, -1], [-0, 1], [1.7976931348623157e308, Infinity],
            [Infinity, 0], [-Infinity, 0], [3, 3], [0, -0]])
        {
            const answer = same('_nextafter', { stack: [...words(x), ...words(y)], control }, {
                host: ()=>({ st0: Infinity }),
            }).st[0];
            const view = new DataView(new ArrayBuffer(8));
            view.setFloat64(0, x);
            const bits = view.getBigUint64(0);
            view.setBigUint64(0, y > x === x > 0 ? bits + 1n : bits - 1n);
            // The double next to x by its bits.
            const expected = x === y ? y : x === 0 ? (y > 0 ? 5e-324 : -5e-324)
                : Number.isFinite(x) ? view.getFloat64(0) : Math.sign(x) * 1.7976931348623157e308;
            assert.ok(Object.is(answer, expected), `_nextafter(${x}, ${y}) is ${answer}`);
        }
    }
});

/** Text's bytes, terminated. @param {string} text */
const bytesOfText = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * What the handler answers for a call the code hands over: the text read as
 * strtod reads it, its end written.
 *
 * @param {Uint8Array} memory @param {number[]} args
 */
function handler(memory, args){
    let text = '';
    for (let at = args[0]; memory[at] !== 0; at++)
    {
        text += String.fromCharCode(memory[at]);
    }
    const scanned = scanDecimal(text);
    if (args.length > 1 && args[1] !== 0)
    {
        new DataView(memory.buffer).setUint32(args[1],
            scanned ? args[0] + scanned.end : args[0], true);
    }
    return { st0: scanned ? scanned.value : 0 };
}

const TEXT = DATA;
const END = DATA + 0x1000;

/** Wine's test_strtod: the text, where strtod stops, and what it answers. */
const WINE = /** @type {[string, number, number][]} */ ([
    ['12.1', 4, 12.1], ['-13.721', 7, -13.721], ['INF', 0, 0], ['.21e12', 6, 210000000000],
    ['214353e-3', 9, 214.353], ['NAN', 0, 0], ['12.1d2', 6, 1210], ['  d10', 0, 0],
    ['0.1', 3, 0.1], ['-0.1', 4, -0.1],
    ['0.1281832188491894198128921', 27, Number('0.1281832188491894198128921')],
    ['0.82181281288121', 16, 0.82181281288121],
    ['21921922352523587651128218821', 29, Number('21921922352523587651128218821')],
    ['0.1d238', 7, 0.1e238], ['0.1D-4736', 9, 0], ['3.4028234663852887e38', 21,
        Number('3.4028234663852887e38')], ['1.1754943508222875e-38', 22,
        Number('1.1754943508222875e-38')],
    ['1.7976931348623158e+308', 23, 1.7976931348623157e308],
    ['1.7976931348623159e+308', 23, Infinity], ['2.2250738585072014e-308', 23, 2 ** -1022],
    ['-1.7976931348623158e+308', 24, -1.7976931348623157e308],
    ['-1.7976931348623159e+308', 24, -Infinity], ['00', 2, 0], ['00.', 3, 0], ['.00', 3, 0],
    ['-0.', 3, -0], ['0e13', 4, 0], ['1d9999999999999999999', 21, Infinity],
]);

test('strtod and atof: Wine\'s cases, the fast path\'s edges and random numbers', ()=>{
    const next = random(44);
    const texts = [...WINE.map(([text])=>text), '', '+', '-', '.', '+.5', '-.', '1e', '1e+',
        '1E-', '7d', '  \t\n12', '0x1p3', '1.5rest', '123456789012345', '1234567890123456',
        '0.000000000000000000001', '9007199254740993', '1e22', '1e23', '1e-22', '1e-23',
        '4.35', '1e+00005', '000000000000000000000000001', '1.' + '0'.repeat(30),
        '12345678901234567890', '0.' + '0'.repeat(40) + '5', '-0', '3.14159', '100000000.5'];
    for (let i = 0; i < 150; i++)
    {
        const digits = String(next() % 1000000000) + (i % 3 === 0 ? String(next() % 1000000) : '');
        const point = next() % (digits.length + 1);
        const exponent = i % 4 === 0 ? `e${next() % 50 - 25}` : i % 4 === 1 ? `D${next() % 8}` : '';
        const sign = i % 2 ? '-' : '';
        texts.push(`${sign}${digits.slice(0, point)}.${digits.slice(point)}${exponent}`);
    }
    for (const control of CONTROLS)
    {
        for (const text of texts)
        {
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[TEXT,
                bytesOfText(text)]]);
            const js = same('strtod', { stack: [TEXT, END], memory, control },
                { host: handler });
            const scanned = scanDecimal(text);
            const expected = scanned ? scanned.value : 0;
            assert.ok(Object.is(js.st[0], expected), `strtod("${text}") is ${js.st[0]}`);
            // The other entries read the same text the same way: under the two
            // precisions a program runs under.
            if (control === 0x27f || control === 0x07f)
            {
                same('strtod', { stack: [TEXT, 0], memory, control }, { host: handler });
                const atof = same('atof', { stack: [TEXT], memory, control }, { host: handler });
                assert.ok(Object.is(atof.st[0], expected), `atof("${text}") is ${atof.st[0]}`);
            }
            assert.equal(new DataView(js.data.buffer).getUint32(END - DATA, true)
                - TEXT, scanned ? scanned.end : 0, `strtod("${text}")'s end`);
        }
    }
    for (const [text, end, value] of WINE)
    {
        const scanned = scanDecimal(text);
        assert.equal(scanned ? scanned.end : 0, end, `"${text}" ends at ${end}`);
        assert.ok(Object.is(scanned ? scanned.value : 0, value), `"${text}" is ${value}`);
    }
    assert.equal(scanDecimal('0.1D-4736')?.range, true, 'an underflow: ERANGE');
    assert.equal(scanDecimal('1.7976931348623159e+308')?.range, true, 'an overflow: ERANGE');
    assert.equal(scanDecimal('0e13')?.range, false, 'a zero is no underflow');
});

test('strtod and atof: numbers of every length, point and scale, correctly rounded', ()=>{
    const next = random(45);
    const digitsOf = (/** @type {number} */ count)=>{
        let text = String(1 + next() % 9);
        for (let i = 1; i < count; i++)
        {
            text += String(next() % 10);
        }
        return text;
    };
    // The one loop's corners: a second point, points and zeros with no
    // digit, fifteen digits either side of a point, and a sixteenth that is
    // a zero past the point.
    const texts = ['1.2.3', '..5', '0.0.1', '.e5', '1.e5', '00.00e5', '-.5', '+.', '.',
        '0.000000000000000000000123456789012345', '123456789012345.000', '12345678.9012345e3',
        '1234567890123456.', '.123456789012345e-7', '999999999999999e22', '1e-22e3'];
    for (let i = 0; i < 300; i++)
    {
        const count = i % 10 < 7 ? 1 + next() % 15 : 16 + next() % 5;
        const digits = (next() % 4 === 0 ? '0'.repeat(1 + next() % 5) : '') + digitsOf(count);
        const point = next() % (digits.length + 2);
        const body = point > digits.length ? digits
            : `${digits.slice(0, point)}.${digits.slice(point)}`;
        const exponent = next() % 5 === 0 ? '' : `${'eEdD'[next() % 4]}`
            + `${['', '+', '-'][next() % 3]}${next() % (i % 7 === 0 ? 400 : 30)}`;
        const sign = ['', '', '-', '+'][next() % 4];
        texts.push(`${sign}${body}${exponent}${['', 'x', ' 7'][next() % 3]}`);
    }
    for (const control of [0x27f, 0x07f])
    {
        for (const text of texts)
        {
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[TEXT,
                bytesOfText(text)]]);
            const scanned = scanDecimal(text);
            const expected = scanned ? scanned.value : 0;
            const js = same('strtod', { stack: [TEXT, END], memory, control }, { host: handler });
            assert.ok(Object.is(js.st[0], expected), `strtod("${text}") is ${js.st[0]}`);
            assert.equal(new DataView(js.data.buffer).getUint32(END - DATA, true) - TEXT,
                scanned ? scanned.end : 0, `strtod("${text}")'s end`);
            const atof = same('atof', { stack: [TEXT], memory, control }, { host: handler });
            assert.ok(Object.is(atof.st[0], expected), `atof("${text}") is ${atof.st[0]}`);
        }
    }
});
