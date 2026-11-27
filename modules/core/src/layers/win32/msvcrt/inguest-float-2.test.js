/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** Part 2 of the floating-point environment and number reading; see `inguest-float.test.js`. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-float.x86.js';
import * as sources from './inguest-float.js';
import { scanDecimal } from './convert.js';
import { DATA, equivalence, random } from
    '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-float.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-float.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double, single, extended, and each with another rounding. */
const CONTROLS = [0x27f, 0x07f, 0x37f, 0xe7f, 0x47f, 0x87f];

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
    // No text at all is the handler's, as the code hands it over.
    for (const control of CONTROLS)
    {
        same('strtod', { stack: [0, END], control }, { host: handler });
        same('atof', { stack: [0], control }, { host: handler });
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

