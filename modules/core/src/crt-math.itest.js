/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's mathematics through the import, as a program calls it: each
 * function in its cdecl and `_CI` forms under a double-precision control word
 * and under the single-precision one Direct3D leaves, the answer stored and
 * errno read through `_errno()` after, the whole written to the console and
 * held to the x87's model of the source (`scripts/guest-code/model.mjs`), to
 * the bit.
 * The calls a function answers itself never reach the host; the ones it
 * leaves to the handler do, and set errno as msvcrt does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { EDOM, ERANGE } from './layers/win32/msvcrt/globals.js';
import * as sources from './layers/win32/msvcrt/inguest-math.js';
import { loadModel } from '../scripts/guest-code/model.mjs';

const SOURCE = new URL('./layers/win32/msvcrt/inguest-math.js', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {number} value */
const halves = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};

/**
 * @typedef {Object} Case
 * @property {string} name
 * @property {number[]} args      Doubles, but for ldexp's second, an int.
 * @property {number} control
 * @property {boolean} hosted     The function hands this call to the handler.
 * @property {number} [errno]
 */

/** Double precision, a Win32 program's own, and single, Direct3D's. */
const CONTROLS = [0x27f, 0x07f];

/** JavaScript's answer for a call handed to the handler. */
const ANSWERS = /** @type {Record<string, (...args: number[]) => number>} */ ({
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
    acos: Math.acos, exp: Math.exp, log: Math.log, log10: Math.log10, sinh: Math.sinh,
    cosh: Math.cosh, pow: Math.pow, _hypot: Math.hypot, ldexp: (x, n)=>x * 2 ** n,
});

/** @type {[string, number[], boolean, number?][]} name, args, handed over, errno */
const CALLS = [
    ['sqrt', [2], false], ['sqrt', [1e-310], false], ['sqrt', [-1], true, EDOM],
    ['sin', [1], false], ['sin', [-2.5e10], false], ['sin', [1e19], true],
    ['sin', [Infinity], true, EDOM], ['cos', [0.75], false], ['tan', [1.5], false],
    ['atan', [3], false], ['atan2', [1, -2], false], ['asin', [0.5], false],
    ['asin', [2], true, EDOM], ['acos', [-0.25], false],
    ['exp', [1], false], ['exp', [-12.5], false], ['exp', [1000], true, ERANGE],
    ['log', [10], false], ['log', [0], true, ERANGE], ['log', [-1], true, EDOM],
    ['log10', [1000], false], ['log10', [0.3], false],
    ['pow', [3, 2], false], ['pow', [10, 0.5], false], ['pow', [7, -1], false],
    ['pow', [10, 2], false], ['pow', [2, 10], false], ['pow', [0, -1], true, ERANGE],
    ['pow', [-8, 1 / 3], true, EDOM],
    ['fmod', [7.5, 2], false], ['fmod', [-7.5, 2], false],
    ['sinh', [0.1], false], ['sinh', [5], false], ['cosh', [3], false], ['tanh', [0.2], false],
    ['tanh', [30], false], ['_hypot', [3, 4], false], ['_hypot', [1.5e308, 1.5e308], true, ERANGE],
    ['ldexp', [1.5, 4], false], ['ldexp', [1, 5000], true, ERANGE],
];

/** The functions with a `_CI` form among them, and the argument counts. */
const INTRINSICS = new Set(['sqrt', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'exp',
    'log', 'log10', 'pow', 'fmod', 'sinh', 'cosh', 'tanh']);

/** @type {Case[]} */
const CASES = CONTROLS.flatMap(control=>CALLS.flatMap(([name, args, hosted, errno])=>[
    { name, args, control, hosted, ...errno === undefined ? {} : { errno } },
    ...INTRINSICS.has(name) ? [{ name: `_CI${name}`, args, control, hosted,
        ...errno === undefined ? {} : { errno } }] : [],
]));

/**
 * Calls every case through the import: errno cleared through `_errno()`,
 * the control word set, the arguments pushed (or loaded, for a `_CI` form),
 * the call, the double stored, the control word put back and errno read;
 * then the answers and errno values written to the console as hex.
 */
function buildMathExe(){
    const names = [...new Set(CASES.map(c=>c.name))];
    /** @type {Record<string, number[]>} */
    const data = {
        apart: new Array(0x1000).fill(0),
        out: new Array(CASES.length * 8).fill(0),
        errs: new Array(CASES.length * 4).fill(0),
        hex: new Array(CASES.length * 24).fill(0),
        digits: [...'0123456789abcdef'].map(c=>c.charCodeAt(0)),
        written: [0, 0, 0, 0],
        normal: u32(0x27f),
        controls: CASES.flatMap(c=>u32(c.control)),
        args: CASES.flatMap(c=>c.args.flatMap((value, i)=>(c.name === 'ldexp' && i === 1
            ? [...u32(value), 0, 0, 0, 0] : halves(value).flatMap(u32)))
            .concat(new Array(16 - c.args.length * 8).fill(0))),
    };
    return buildExe({
        imports: {
            'msvcrt.dll': [...names, '_errno'],
            'KERNEL32.dll': ['ExitProcess', 'GetStdHandle', 'WriteFile'],
        },
        data,
        codeSize: 0x4000,
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const code = [];
            CASES.forEach((c, i)=>{
                const arg = (/** @type {number} */ k)=>at('args') + i * 16 + k * 8;
                code.push(0xff, 0x15, ...u32(iat('_errno')), 0xc7, 0x00, 0, 0, 0, 0); // errno = 0
                code.push(0xd9, 0x2d, ...u32(at('controls') + i * 4));        // fldcw
                if (c.name.startsWith('_CI'))
                {
                    c.args.forEach((_, k)=>code.push(0xdd, 0x05, ...u32(arg(k)))); // fld each
                    code.push(0xff, 0x15, ...u32(iat(c.name)));
                }
                else
                {
                    const slots = c.name === 'ldexp' ? 3 : c.args.length * 2;
                    for (let s = slots - 1; s >= 0; s--)
                    {
                        code.push(0xff, 0x35, ...u32(at('args') + i * 16 + s * 4)); // push slot
                    }
                    code.push(0xff, 0x15, ...u32(iat(c.name)), 0x83, 0xc4, slots * 4);
                }
                code.push(0xdd, 0x1d, ...u32(at('out') + i * 8));             // fstp [out]
                code.push(0xd9, 0x2d, ...u32(at('normal')));                  // fldcw 0x27f
                code.push(0xff, 0x15, ...u32(iat('_errno')), 0x8b, 0x00);     // eax = errno
                code.push(0xa3, ...u32(at('errs') + i * 4));                  // mov [errs], eax
            });
            const byte = [
                0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04, 0x83, 0xe2, 0x0f,
                0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,
                0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,
                0x46, 0x83, 0xc7, 0x02, 0x49,
            ];
            const bytes = CASES.length * 12;
            code.push(0xbe, ...u32(at('out')), 0xbf, ...u32(at('hex')), 0xb9, ...u32(bytes),
                ...byte, 0x75, 0x100 - byte.length - 2,
                0x6a, 0x00, 0x68, ...u32(at('written')), 0x68, ...u32(bytes * 2),
                0x68, ...u32(at('hex')), 0x6a, 0xf5, 0xff, 0x15, ...u32(iat('GetStdHandle')), 0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')));
            return code;
        },
    });
}

/**
 * Runs the program; answers the doubles and errno values it wrote and the
 * host's calls by name.
 */
async function run(){
    const app = await createApp({
        executable: buildMathExe(),
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
        assert.equal(bytes.length, CASES.length * 12, 'the whole dump');
        const view = new DataView(bytes.buffer);
        return {
            values: CASES.map((_, i)=>view.getFloat64(i * 8, true)),
            errnos: CASES.map((_, i)=>view.getInt32(CASES.length * 8 + i * 4, true)),
            crossed: new Map(/** @type {[string, number][]} */ (bridge?.metrics?.hot ?? [])),
        };
    }
    finally
    {
        await app.dispose();
    }
}

/** The distance between two doubles in units in the last place. @param {number} a @param {number} b */
function ulps(a, b){
    if (Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b))
    {
        return 0;
    }
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, a);
    view.setFloat64(8, b);
    const d = view.getBigInt64(0) - view.getBigInt64(8);
    return Math.sign(a) !== Math.sign(b) ? Infinity : Number(d < 0n ? -d : d);
}

const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-math.js', url: SOURCE.href, values: sources,
});

/** What the model answers for a case: the source under its control word, or the handler's. */
function expected(/** @type {Case} */ c){
    const base = c.name.replace(/^_CI/, '');
    if (c.hosted)
    {
        return ANSWERS[base](...c.args);
    }
    model.$.control = c.control;
    const fn = /** @type {Function} */ (model.module[base]);
    const helpers = { host: ()=>{
        throw new Error(`${c.name}(${c.args}) is handed over in the model`);
    } };
    return fn.length > c.args.length ? fn(helpers, ...c.args) : fn(...c.args);
}

test(`the runtime's mathematics through the import`, { timeout: 120000 },
    async()=>{
        const { values, errnos, crossed } = await run();
        /** @type {string[]} */
        const wrong = [];
        CASES.forEach((c, i)=>{
            const what = `${c.name}(${c.args}) under 0x${c.control.toString(16)}`;
            const want = expected(c);
            const distance = ulps(values[i], want);
            if (distance > 0)
            {
                wrong.push(`${what}: ${values[i]} where the model answers ${want} `
                    + `(${distance} ulp)`);
            }
            if (errnos[i] !== (c.errno ?? 0))
            {
                wrong.push(`${what}: errno ${errnos[i]}, not ${c.errno ?? 0}`);
            }
        });
        assert.deepEqual(wrong, []);
        for (const name of new Set(CASES.map(c=>c.name)))
        {
            const handed = CASES.filter(c=>c.name === name && c.hosted).length;
            assert.equal(crossed.get(`msvcrt.dll!${name}`) ?? 0, handed,
                `${name}: only the calls it hands over crossed into the host`);
        }
    });
