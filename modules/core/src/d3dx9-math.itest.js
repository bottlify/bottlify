/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's mathematics through the import, as a program calls it: the
 * builders, the quaternions, projection, planes and halves, each imported
 * from one of the versions d3dx9_24 to d3dx9_43, called under a
 * double-precision control word and under the single-precision one Direct3D
 * leaves, the outputs and the result dumped to the console and held to the
 * x87's model of the source (`scripts/guest-code/model.mjs`), to the bit.
 * None of the calls reaches the host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { guestEntry } from './layers/win32/msvcrt/guest-code.js';
import { loadModel } from '../scripts/guest-code/model.mjs';

/** Each module of d3dx9's guest code: its model and what the build made of it. */
const MODULES = await Promise.all(['inguest', 'inguest-matrix', 'inguest-vector',
    'inguest-quaternion'].map(async name=>{
    const url = new URL(`./layers/win32/d3dx9/${name}.js`, import.meta.url);
    const values = await import(url.href);
    const model = await loadModel(await readFile(url, 'utf8'), {
        file: `${name}.js`, url: url.href, values,
    });
    const { COMPILED } = await import(new URL(`./layers/win32/d3dx9/${name}.x86.js`,
        import.meta.url).href);
    return { model, compiled: /** @type {Record<string, any>} */ (COMPILED) };
}));

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {number} value */
const floatBits = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
};

/** The inputs, by name: floats, but for the viewport's four dwords and a float's raw bits. */
const INPUTS = /** @type {Record<string, number[]>} */ ({
    m: [10, 5, 7, 8, 11, 20, 16, 33, 19, -21, 30, 43, 2, 3, -4, -40],
    n: [1, 5, -8, -4, 2, 6, -7, -3, 3, 7, -6, -2, 4, 8, -5, -1.5],
    world: [21, 2, 3, 4, 5, 23, 7, 8, -8, -7, 25, -5, -4, -3, -2, 27],
    eye: [8, -5, 5.75, 0],
    at: [-2, 13, -9, 0],
    up: [1, -3, 7, 0],
    q1: [0.1, 0.2, 0.3, 0.927362],
    q2: [0.5, 0.6, 0.1, -0.616441],
    q3: [-0.3, 0.8, 0.2, 0.479583],
    q4: [0.9, -0.1, 0.4, 0.141421],
    r: [0.87, 0.65, 0.43, 0.21],
    points: [9, 6, 2, 1, -3, 0.5, 4, 8, 7, -2, 0.25, 3],
    plane: [-3, -1, 4, 7],
    halves: [80000, 65504, 65520, -1.5, 3.14159, 1e-7, 6e-8, -0],
});

/** The viewport: X, Y, Width, Height as dwords, MinZ and MaxZ as floats. */
const VIEWPORT = [10, 5, 800, 680, floatBits(0.2), floatBits(0.9)];

/**
 * @typedef {{ in: string, at?: number } | { out: number } | { float: number } | { word: number }
 *     | null} Arg
 *   A pointer into an input, a pointer into the case's output, a FLOAT, a
 *   dword, or NULL.
 */

/** @type {[string, string, Arg[], 'u32' | 'f32' | 'void'][]} dll, name, args, result */
const CALLS = [
    ['d3dx9_36.dll', 'D3DXMatrixRotationYawPitchRoll', [{ out: 0 }, { float: 0.3 },
        { float: -1.2 }, { float: 2.5 }], 'u32'],
    ['d3dx9_24.dll', 'D3DXMatrixPerspectiveFovLH', [{ out: 0 }, { float: Math.PI / 4 },
        { float: 4 / 3 }, { float: 1 }, { float: 1000 }], 'u32'],
    ['d3dx9_43.dll', 'D3DXMatrixLookAtLH', [{ out: 0 }, { in: 'eye' }, { in: 'at' },
        { in: 'up' }], 'u32'],
    ['d3dx9_30.dll', 'D3DXMatrixTransformation', [{ out: 0 }, { in: 'at' }, { in: 'q1' },
        { in: 'up' }, { in: 'eye' }, { in: 'r' }, { in: 'eye' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXMatrixDeterminant', [{ in: 'm' }], 'f32'],
    ['d3dx9_25.dll', 'D3DXMatrixInverse', [{ out: 0 }, { out: 64 }, { in: 'm' }], 'u32'],
    ['d3dx9_26.dll', 'D3DXMatrixMultiply', [{ out: 0 }, { in: 'm' }, { in: 'world' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXMatrixAffineTransformation2D', [{ out: 0 }, { float: 20 },
        { in: 'eye' }, { float: 1.04719758 }, { in: 'up' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXMatrixDecompose', [{ out: 0 }, { out: 16 }, { out: 32 },
        { in: 'world' }], 'u32'],
    ['d3dx9_40.dll', 'D3DXQuaternionSlerp', [{ out: 0 }, { in: 'q1' }, { in: 'q2' },
        { float: 0.3 }], 'u32'],
    ['d3dx9_36.dll', 'D3DXQuaternionRotationMatrix', [{ out: 0 }, { in: 'n' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXQuaternionSquadSetup', [{ out: 0 }, { out: 16 }, { out: 32 },
        { in: 'q1' }, { in: 'q2' }, { in: 'q3' }, { in: 'q4' }], 'void'],
    ['d3dx9_36.dll', 'D3DXQuaternionSquad', [{ out: 0 }, { in: 'q1' }, { in: 'q2' },
        { in: 'q3' }, { in: 'q4' }, { float: 0.7 }], 'u32'],
    ['d3dx9_36.dll', 'D3DXQuaternionToAxisAngle', [{ in: 'q3' }, { out: 0 }, { out: 12 }],
        'void'],
    ['d3dx9_36.dll', 'D3DXVec3Project', [{ out: 0 }, { in: 'points' }, { in: 'viewport' },
        { in: 'n' }, { in: 'm' }, { in: 'world' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXVec3Unproject', [{ out: 0 }, { in: 'points' }, { in: 'viewport' },
        { in: 'n' }, { in: 'm' }, { in: 'world' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXVec3TransformCoordArray', [{ out: 0 }, { word: 16 },
        { in: 'points' }, { word: 12 }, { in: 'world' }, { word: 4 }], 'u32'],
    ['d3dx9_36.dll', 'D3DXVec4Cross', [{ out: 0 }, { in: 'q1' }, { in: 'q2' }, { in: 'q3' }],
        'u32'],
    ['d3dx9_36.dll', 'D3DXPlaneFromPoints', [{ out: 0 }, { in: 'points' },
        { in: 'points', at: 12 }, { in: 'points', at: 24 }], 'u32'],
    ['d3dx9_36.dll', 'D3DXPlaneIntersectLine', [{ out: 0 }, { in: 'plane' }, { in: 'eye' },
        { in: 'at' }], 'u32'],
    ['d3dx9_36.dll', 'D3DXFloat32To16Array', [{ out: 0 }, { in: 'halves' }, { word: 8 }], 'u32'],
    ['d3dx9_36.dll', 'D3DXColorAdjustSaturation', [{ out: 0 }, { in: 'q1' }, { float: 0.3 }],
        'u32'],
    ['d3dx9_36.dll', 'D3DXFresnelTerm', [{ float: 0.5 }, { float: 1.5 }], 'f32'],
];

/** Double precision, a Win32 program's own, and single, Direct3D's. */
const CONTROLS = [0x27f, 0x07f];

const CASES = CONTROLS.flatMap(control=>CALLS.map(([dll, name, args, result])=>
    ({ dll, name, args, result, control })));

/** The bytes each case has for its outputs. */
const OUT_SIZE = 80;

/** Where the builder put each blob, once it has. */
/** @type {Record<string, number>} */
const placed = {};

function buildD3dxExe(){
    /** @type {Record<string, string[]>} */
    const imports = { 'KERNEL32.dll': ['ExitProcess', 'GetStdHandle', 'WriteFile'] };
    for (const [dll, name] of CALLS)
    {
        (imports[dll] ??= []).push(name);
    }
    /** @type {Record<string, number[]>} */
    const data = {
        outs: new Array(CASES.length * OUT_SIZE).fill(0),
        results: new Array(CASES.length * 4).fill(0),
        hex: new Array(CASES.length * (OUT_SIZE + 4) * 2).fill(0),
        digits: [...'0123456789abcdef'].map(c=>c.charCodeAt(0)),
        written: [0, 0, 0, 0],
        normal: u32(0x27f),
        controls: CASES.flatMap(c=>u32(c.control)),
        viewport: VIEWPORT.flatMap(u32),
        ...Object.fromEntries(Object.entries(INPUTS).map(([name, values])=>[name,
            values.flatMap(value=>u32(floatBits(value)))])),
    };
    return buildExe({
        imports,
        data,
        codeSize: 0x2000,
        code: ({ iat, at })=>{
            for (const name of Object.keys(data))
            {
                placed[name] = at(name);
            }
            /** @type {number[]} */
            const code = [];
            CASES.forEach((c, i)=>{
                const out = at('outs') + i * OUT_SIZE;
                code.push(0xd9, 0x2d, ...u32(at('controls') + i * 4));         // fldcw
                for (const arg of [...c.args].reverse())
                {
                    const word = arg === null ? 0 : 'in' in arg ? at(arg.in) + (arg.at ?? 0)
                        : 'out' in arg ? out + arg.out : 'float' in arg ? floatBits(arg.float)
                            : arg.word;
                    code.push(0x68, ...u32(word));                              // push
                }
                code.push(0xff, 0x15, ...u32(iat(c.name)));                    // call (stdcall)
                if (c.result === 'f32')
                {
                    code.push(0xd9, 0x1d, ...u32(at('results') + i * 4));      // fstp dword
                }
                else
                {
                    code.push(0xa3, ...u32(at('results') + i * 4));            // mov [results], eax
                }
                code.push(0xd9, 0x2d, ...u32(at('normal')));                   // fldcw 0x27f
            });
            const byte = [
                0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04, 0x83, 0xe2, 0x0f,
                0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,
                0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,
                0x46, 0x83, 0xc7, 0x02, 0x49,
            ];
            const bytes = CASES.length * (OUT_SIZE + 4);
            code.push(0xbe, ...u32(at('outs')), 0xbf, ...u32(at('hex')), 0xb9, ...u32(bytes),
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
 * Runs the program; answers each case's output bytes and result, and the
 * host's calls by name.
 */
async function run(){
    const app = await createApp({
        executable: buildD3dxExe(),
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
        assert.equal(bytes.length, CASES.length * (OUT_SIZE + 4), 'the whole dump');
        const results = new DataView(bytes.buffer, CASES.length * OUT_SIZE);
        return {
            outs: CASES.map((_, i)=>bytes.slice(i * OUT_SIZE, (i + 1) * OUT_SIZE)),
            results: CASES.map((_, i)=>results.getUint32(i * 4, true)),
            crossed: new Map(/** @type {[string, number][]} */ (bridge?.metrics?.hot ?? [])),
        };
    }
    finally
    {
        await app.dispose();
    }
}

/**
 * What the model answers for a case: the source under its control word, over
 * a memory laid out as the program's is.
 *
 * @param {typeof CASES[number]} c @param {number} i
 */
function expected(c, i){
    const memory = new Uint8Array(0x1000000);
    for (const name of [...Object.keys(INPUTS), 'viewport'])
    {
        const values = name === 'viewport' ? VIEWPORT.flatMap(u32)
            : INPUTS[name].flatMap(value=>u32(floatBits(value)));
        memory.set(values, placed[name]);
    }
    const out = placed.outs + i * OUT_SIZE;
    const module = MODULES.find(({ compiled })=>c.name in compiled);
    if (!module)
    {
        throw new Error(`no module compiles ${c.name}`);
    }
    module.model.$.control = c.control;
    /** @type {number} */
    let result = 0;
    const entry = guestEntry(/** @type {Function} */ (module.model.module[c.name]),
        module.compiled[c.name], {
            readMemory: (address, length)=>memory.subarray(address, address + length),
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            fpu: {
                setResult: value=>{
                    result = floatBits(value);
                },
                get: ()=>0,
                pop: ()=>{},
            },
        });
    const eax = entry.handler(c.args.map(arg=>(arg === null ? 0 : 'in' in arg
        ? placed[arg.in] + (arg.at ?? 0) : 'out' in arg ? out + arg.out
            : 'float' in arg ? floatBits(arg.float) : arg.word))) >>> 0;
    return {
        out: memory.slice(out, out + OUT_SIZE),
        result: c.result === 'f32' ? result : c.result === 'void' ? 0 : eax,
    };
}

test(`d3dx9's mathematics through the import`, { timeout: 120000 },
    async()=>{
        const { outs, results, crossed } = await run();
        /** @type {string[]} */
        const wrong = [];
        CASES.forEach((c, i)=>{
            const what = `${c.dll}!${c.name} under 0x${c.control.toString(16)}`;
            const want = expected(c, i);
            const got = new DataView(outs[i].buffer);
            const wanted = new DataView(want.out.buffer);
            for (let at = 0; at < OUT_SIZE; at += 4)
            {
                if (got.getUint32(at, true) !== wanted.getUint32(at, true))
                {
                    wrong.push(`${what}: +${at} is ${got.getFloat32(at, true)} where the model `
                        + `answers ${wanted.getFloat32(at, true)}`);
                }
            }
            if (c.result !== 'void' && results[i] !== want.result)
            {
                wrong.push(`${what}: answers 0x${results[i].toString(16)} where the model `
                    + `answers 0x${want.result.toString(16)}`);
            }
        });
        assert.deepEqual(wrong, []);
        for (const [dll, name] of CALLS)
        {
            assert.equal(crossed.get(`${dll}!${name}`) ?? 0, 0,
                `${dll}!${name}: no call crossed into the host`);
        }
    });
