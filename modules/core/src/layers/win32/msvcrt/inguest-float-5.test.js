/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * wcstod and _wtof in the guest: their x86 (and x86-64) against their
 * JavaScript, and that JavaScript against what the host's reading answers
 * (`scanDecimal`) for numbers of every length, point and scale written in
 * units -- a unit past ASCII where the number stops ending it as any other
 * character does, the end two bytes a character.
 */

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

/** A text's units and its terminator, as bytes. @param {string} text */
const unitsOfText = text=>[...text, '\0'].flatMap(c=>[c.charCodeAt(0) & 0xff,
    c.charCodeAt(0) >>> 8]);

/**
 * The host's wcstod over a region: the number it reads, and its end written.
 *
 * @param {Uint8Array} memory @param {number[]} args
 */
function handler(memory, args){
    const view = new DataView(memory.buffer);
    let text = '';
    for (let at = args[0]; view.getUint16(at, true) !== 0; at += 2)
    {
        text += String.fromCharCode(view.getUint16(at, true));
    }
    const scanned = scanDecimal(text);
    if (args.length > 1 && args[1] !== 0)
    {
        view.setUint32(args[1], scanned ? args[0] + scanned.end * 2 : args[0], true);
    }
    return { st0: scanned ? scanned.value : 0 };
}

const TEXT = DATA;
const END = DATA + 0x1000;

test('wcstod and _wtof: numbers of every length, point and scale in units, correctly rounded',
    ()=>{
        const next = random(47);
        const digitsOf = (/** @type {number} */ count)=>{
            let text = String(1 + next() % 9);
            for (let i = 1; i < count; i++)
            {
                text += String(next() % 10);
            }
            return text;
        };
        // What stops the reading past ASCII: a full-width digit and space, an Arabic-Indic
        // digit, a letter whose low byte is a digit's.
        const texts = ['1.2.3', '..5', '.e5', '1.e5', '-.5', '+.', '　 1', '12３',
            '7١', 'ı', '1İ', '5Ā', '  -0.25e1x', '1e5', ''];
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
            texts.push(`${['', ' ', '\t'][next() % 3]}${sign}${body}${exponent}`
                + `${['', 'x', ' 7', '　', '١'][next() % 5]}`);
        }
        for (const control of [0x27f, 0x07f])
        {
            for (const text of texts)
            {
                const memory = /** @type {[number, ArrayLike<number>][]} */ ([[TEXT,
                    unitsOfText(text)]]);
                const scanned = scanDecimal(text);
                const expected = scanned ? scanned.value : 0;
                const label = JSON.stringify(text);
                const js = same('wcstod', { stack: [TEXT, END], memory, control },
                    { host: handler });
                assert.ok(Object.is(js.st[0], expected), `wcstod(${label}) is ${js.st[0]}`);
                assert.equal(new DataView(js.data.buffer).getUint32(END - DATA, true) - TEXT,
                    scanned ? 2 * scanned.end : 0, `wcstod(${label})'s end`);
                const wtof = same('_wtof', { stack: [TEXT], memory, control }, { host: handler });
                assert.ok(Object.is(wtof.st[0], expected), `_wtof(${label}) is ${wtof.st[0]}`);
            }
        }
        same('wcstod', { stack: [0, END], control: 0x27f }, { host: handler });
    });
