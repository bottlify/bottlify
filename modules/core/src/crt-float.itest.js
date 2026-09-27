/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's floating-point environment, classifications, number reading
 * and division through the import, as a program calls them, on cork and on
 * the emulator: a precision `_controlfp` sets is the precision the program's
 * own division then rounds to, `_clearfp` answers the zero-divide a division
 * by zero raised and clears it, strtod reads its number and its end and sets
 * errno for an overflow -- the three calls past the fast path handed to the
 * host, the rest answered in the guest -- and div answers its remainder in EDX -- each result
 * written to the console and held to msvcrt's answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { ERANGE } from './layers/win32/msvcrt/globals.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {number} value */
const halves = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * @typedef {Object} Call
 * @property {string} name
 * @property {(number | { text: string } | { end: true })[]} args  Dwords, texts, the end slot.
 * @property {'eax' | 'double'} result
 */

/** @type {[string, Call['args'], Call['result']][]} */
const CALLS = [
    ['_controlfp', [0x20000, 0x30000], 'eax'],       // single precision
    ['_controlfp', [0x10000, 0x30000], 'eax'],       // double again
    ['_control87', [0, 0], 'eax'],
    ['_clearfp', [], 'eax'],
    ['_clearfp', [], 'eax'],                         // after a division by zero
    ['_statusfp', [], 'eax'],
    ['atof', [{ text: '  3.14159' }], 'double'],
    ['strtod', [{ text: '-1.5e300xyz' }, { end: true }], 'double'],
    ['strtod', [{ text: '1e400' }, { end: true }], 'double'],
    ['strtod', [{ text: '0.1281832188491894198128921' }, { end: true }], 'double'],
    ['_copysign', [...halves(2.5), ...halves(-0)], 'double'],
    ['_chgsign', halves(1), 'double'],
    ['_fpclass', halves(-0), 'eax'],
    ['_isnan', halves(NaN), 'eax'],
    ['_finite', halves(Infinity), 'eax'],
    ['_logb', halves(1024), 'double'],
    ['_nextafter', [...halves(1), ...halves(2)], 'double'],
    ['_scalb', [...halves(1), 10], 'double'],
    ['div', [-7, 2], 'eax'],
    ['ldiv', [7, -2], 'eax'],
];

/** Where the builder put each text, once it has. @type {Record<string, number>} */
const placed = {};

/**
 * Every call through the import, cdecl: errno cleared first, the answer's
 * EAX and EDX, or its double, stored, and errno read after; between the two
 * `_controlfp` calls the program divides 1 by 3 itself, and before the
 * second `_clearfp` divides 1 by 0; then everything written out as hex.
 */
function buildFloatExe(){
    /** @type {Record<string, number[]>} */
    const data = {
        eaxes: new Array(CALLS.length * 4).fill(0),
        edxes: new Array(CALLS.length * 4).fill(0),
        doubles: new Array(CALLS.length * 8).fill(0),
        errs: new Array(CALLS.length * 4).fill(0),
        ends: new Array(CALLS.length * 4).fill(0),
        thirds: new Array(16).fill(0),
        hex: new Array((CALLS.length * 24 + 16) * 2).fill(0),
        digits: [...'0123456789abcdef'].map(c=>c.charCodeAt(0)),
        written: [0, 0, 0, 0],
        three: u32(3),
        ...Object.fromEntries(CALLS.flatMap(([, args], i)=>args.filter(arg=>typeof arg === 'object'
            && 'text' in arg).map(arg=>[`text${i}`, cString(/** @type {any} */ (arg).text)]))),
    };
    return buildExe({
        imports: {
            'msvcrt.dll': [...new Set(CALLS.map(([name])=>name)), '_errno'],
            'KERNEL32.dll': ['ExitProcess', 'GetStdHandle', 'WriteFile'],
        },
        data,
        codeSize: 0x1000,
        code: ({ iat, at })=>{
            for (const name of Object.keys(data))
            {
                placed[name] = at(name);
            }
            /** @type {number[]} */
            const code = [];
            /** 1 / 3 as the program's own x87 divides it, stored. @param {number} slot */
            const third = slot=>code.push(0xd9, 0xe8, 0xda, 0x35, ...u32(at('three')),
                0xdd, 0x1d, ...u32(at('thirds') + slot * 8));      // fld1; fidiv; fstp qword
            CALLS.forEach(([name, args, result], i)=>{
                if (i === 1)
                {
                    third(0);
                }
                if (i === 4)
                {
                    // fld1; fldz; fdivp st1: 1 / 0, the zero-divide raised; fstp st0.
                    code.push(0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9, 0xdd, 0xd8);
                }
                code.push(0xff, 0x15, ...u32(iat('_errno')), 0xc7, 0x00, 0, 0, 0, 0);
                for (const arg of [...args].reverse())
                {
                    const word = typeof arg === 'number' ? arg >>> 0
                        : 'text' in arg ? at(`text${i}`) : at('ends') + i * 4;
                    code.push(0x68, ...u32(word));
                }
                code.push(0xff, 0x15, ...u32(iat(name)));
                if (args.length > 0)
                {
                    code.push(0x83, 0xc4, args.length * 4);
                }
                if (result === 'double')
                {
                    code.push(0xdd, 0x1d, ...u32(at('doubles') + i * 8));
                }
                code.push(0xa3, ...u32(at('eaxes') + i * 4));          // mov [eaxes], eax
                code.push(0x89, 0x15, ...u32(at('edxes') + i * 4));    // mov [edxes], edx
                code.push(0xff, 0x15, ...u32(iat('_errno')), 0x8b, 0x00);
                code.push(0xa3, ...u32(at('errs') + i * 4));
                if (i === 1)
                {
                    third(1);
                }
            });
            const byte = [
                0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04, 0x83, 0xe2, 0x0f,
                0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,
                0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,
                0x46, 0x83, 0xc7, 0x02, 0x49,
            ];
            const bytes = CALLS.length * 24 + 16;
            code.push(0xbe, ...u32(at('eaxes')), 0xbf, ...u32(at('hex')), 0xb9, ...u32(bytes),
                ...byte, 0x75, 0x100 - byte.length - 2,
                0x6a, 0x00, 0x68, ...u32(at('written')), 0x68, ...u32(bytes * 2),
                0x68, ...u32(at('hex')), 0x6a, 0xf5, 0xff, 0x15, ...u32(iat('GetStdHandle')), 0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')));
            return code;
        },
    });
}

/** @param {'cork' | 'emulator'} engine */
async function run(engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: buildFloatExe(),
        engine,
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    /** @type {string[]} */
    const output = [];
    app.on('output', (/** @type {any} */ payload)=>output.push(payload.text));
    try
    {
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, 'the program exits 0');
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        const text = output.join('');
        const bytes = new Uint8Array(text.length >> 1);
        for (let i = 0; i < bytes.length; i++)
        {
            bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
        }
        const view = new DataView(bytes.buffer);
        const n = CALLS.length;
        return {
            eax: CALLS.map((_, i)=>view.getUint32(i * 4, true)),
            edx: CALLS.map((_, i)=>view.getUint32(n * 4 + i * 4, true)),
            doubles: CALLS.map((_, i)=>view.getFloat64(n * 8 + i * 8, true)),
            errnos: CALLS.map((_, i)=>view.getInt32(n * 16 + i * 4, true)),
            ends: CALLS.map((_, i)=>view.getUint32(n * 20 + i * 4, true)),
            thirds: [view.getFloat64(n * 24, true), view.getFloat64(n * 24 + 8, true)],
            crossed: new Map(/** @type {[string, number][]} */ (bridge?.metrics?.hot ?? [])),
        };
    }
    finally
    {
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`the runtime's floating-point environment and conversions, under ${engine}`,
        { timeout: 120000 }, async()=>{
            const { eax, edx, doubles, errnos, ends, thirds, crossed } = await run(engine);
            assert.equal(eax[0], 0xa001f, '_controlfp answers single precision');
            assert.equal(thirds[0], Math.fround(1 / 3), 'and the program\'s 1 / 3 rounds to it');
            assert.equal(eax[1], 0x9001f, '_controlfp answers double precision again');
            assert.equal(thirds[1], 1 / 3, 'and 1 / 3 is the double');
            assert.equal(eax[2], 0x9001f, '_control87 reads the same word');
            assert.equal(eax[4] & 0x8, 0x8, '_clearfp answers the zero-divide raised');
            assert.equal(eax[5], 0, 'and cleared it');
            assert.equal(doubles[6], 3.14159);
            assert.equal(doubles[7], -1.5e300);
            assert.equal(ends[7] - placed.text7, 8, 'strtod stops before the x');
            assert.equal(ends[8] - placed.text8, 5);
            assert.equal(ends[9] - placed.text9, 27);
            assert.equal(doubles[8], Infinity);
            assert.equal(errnos[8], ERANGE, 'an overflow sets ERANGE');
            assert.equal(errnos[7], 0, 'a number in range sets nothing');
            assert.equal(doubles[9], Number('0.1281832188491894198128921'));
            assert.ok(Object.is(doubles[10], -2.5));
            assert.equal(doubles[11], -1);
            assert.equal(eax[12], 0x20, '-0 is a negative zero');
            assert.equal(eax[13], 1);
            assert.equal(eax[14], 0);
            assert.equal(doubles[15], 10);
            assert.equal(doubles[16], 1 + 2 ** -52);
            assert.equal(doubles[17], 1024);
            assert.deepEqual([eax[18] | 0, edx[18] | 0], [-3, -1], 'div(-7, 2)');
            assert.deepEqual([eax[19] | 0, edx[19] | 0], [-3, 1], 'ldiv(7, -2)');
            for (const [name] of CALLS)
            {
                const handed = name === 'strtod' ? 3 : 0;
                assert.equal(crossed.get(`msvcrt.dll!${name}`) ?? 0, handed,
                    `${name}: only the calls it hands over crossed into the host`);
            }
        });
}
