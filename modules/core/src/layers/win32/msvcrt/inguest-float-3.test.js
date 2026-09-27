/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** Part 3 of the floating-point environment and number reading; see `inguest-float.test.js`. */

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
