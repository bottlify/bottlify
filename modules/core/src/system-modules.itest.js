/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The system modules in the module window: how much of it they take, and
 * that a program importing two versions of d3dx9 and msvcrt still finds each
 * one where Windows would -- its own handle, its own exports, its own file
 * name, a version loaded at run time counted and unloaded -- and computes
 * through all of them.
 *
 * The window is the span between the program's image and the pool of thread
 * stacks (`spaceAbove` in `app.js`): the system modules go first, and what
 * they leave is the room for the libraries a program brings, which can be
 * tens of megabytes between them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, spaceAbove } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';


/** Windows' allocation granularity, at which every image is placed. */
const GRANULE = 0x10000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** @param {number[]} values */
const floats = values=>values.flatMap(value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return u32(view.getUint32(0, true));
});

/** @param {number} value */
const up = value=>Math.ceil(value / GRANULE) * GRANULE;

test('the system modules take their own images\' room in the module window, and no more',
    { timeout: 60000 }, async t=>{
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            codeSize: 0x10,
            code: ({ iat })=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());

        const header = new DataView(executable.buffer, executable.byteOffset);
        const optional = header.getUint32(0x3c, true) + 24;
        const { moduleBase, stackPoolBase } = spaceAbove(header.getUint32(optional + 28, true)
            + header.getUint32(optional + 56, true));
        const memory = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'memory');
        /** @type {Map<string, { base: number, end: number }>} */
        const modules = new Map();
        for (const line of /** @type {string[]} */ (memory?.metrics?.layout ?? []))
        {
            const [, name, base, size] = /^(.*) 0x([0-9a-f]+)\+0x([0-9a-f]+) \S+$/.exec(line) ?? [];
            const at = parseInt(base, 16);
            // The window holds the system modules and the arena the process
            // starts from; a program that brings no library brings nothing else.
            if (at < moduleBase || at >= stackPoolBase || name === 'process-startup')
            {
                continue;
            }
            const module = name.replace(/ \.data$/, '');
            const held = modules.get(module) ?? { base: at, end: at };
            held.base = Math.min(held.base, at);
            held.end = Math.max(held.end, at + parseInt(size, 16));
            modules.set(module, held);
        }
        const placed = [...modules.values()].sort((a, b)=>a.base - b.base);
        assert.ok(placed.length > 40, `the system modules are all there (${placed.length})`);
        assert.equal(placed[0].base, moduleBase, 'the first at the window\'s start');

        const span = up(placed[placed.length - 1].end) - moduleBase;
        const own = placed.reduce((sum, module)=>sum + up(module.end - module.base), 0);
        const window = stackPoolBase - moduleBase;
        t.diagnostic(`${placed.length} system modules: ${(span / 2 ** 20).toFixed(2)} MiB of the `
            + `window's ${window / 2 ** 20} MiB, their images ${(own / 2 ** 20).toFixed(2)} MiB`);
        assert.equal(span, own, 'each module where the one before it ends, at the granule');
        assert.ok(span <= window / 8,
            `${(span / 2 ** 20).toFixed(2)} MiB is past an eighth of the window`);
    });

/**
 * The program: the handles, exports and file names of d3dx9_30 and d3dx9_43,
 * which it imports, and of d3dx9_36, which it loads and frees; a matrix
 * product through each of the three, a vector normalised through d3dx9_43
 * and a number read by msvcrt's atof. Every answer goes into `words`.
 */
function buildProgram(){
    const m = [1, 2, 3, 4, 5, 6, 7, 8, -1, -2, -3, -4, 2, 0, 1, 3];
    const n = [2, 0, 1, -1, 3, 1, 0, 2, -2, 4, 1, 0, 1, 1, 1, 1];
    /** @type {Record<string, number>} */
    const at = {};
    const executable = buildExe({
        imports: {
            'KERNEL32.dll': ['GetModuleHandleA', 'GetProcAddress', 'GetModuleFileNameA',
                'LoadLibraryA', 'FreeLibrary', 'ExitProcess'],
            'd3dx9_30.dll': ['D3DXMatrixMultiply'],
            'd3dx9_43.dll': ['D3DXVec3Normalize'],
            'msvcrt.dll': ['atof'],
        },
        data: {
            words: new Array(20 * 4).fill(0),
            name30: cString('d3dx9_30.dll'),
            name43: cString('d3dx9_43.dll'),
            name36: cString('D3DX9_36'),
            multiply: cString('D3DXMatrixMultiply'),
            normalize: cString('D3DXVec3Normalize'),
            file30: new Array(260).fill(0),
            file43: new Array(260).fill(0),
            m: floats(m),
            n: floats(n),
            vector: floats([3, 0, -4]),
            out30: new Array(64).fill(0),
            out36: new Array(64).fill(0),
            out43: new Array(64).fill(0),
            outVector: new Array(12).fill(0),
            text: cString(' 2.5e3'),
            number: new Array(8).fill(0),
        },
        codeSize: 0x200,
        code: ({ iat, at: of })=>{
            for (const name of ['words', 'file30', 'file43', 'out30', 'out36', 'out43',
                'outVector', 'number'])
            {
                at[name] = of(name);
            }
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {string} name */
            const push = name=>[0x68, ...u32(of(name))];
            /** @param {number} i */
            const word = i=>of('words') + i * 4;
            /** @param {number} i */
            const store = i=>[0xa3, ...u32(word(i))];                        // mov [word], eax
            /** @param {number} i */
            const pushWord = i=>[0xff, 0x35, ...u32(word(i))];               // push [word]
            /** @param {string} out */
            const product = out=>[...push('n'), ...push('m'), ...push(out)];
            return [
                ...push('name30'), ...call('GetModuleHandleA'), ...store(0),
                ...push('name43'), ...call('GetModuleHandleA'), ...store(1),
                ...push('multiply'), ...pushWord(0), ...call('GetProcAddress'), ...store(2),
                0xa1, ...u32(iat('D3DXMatrixMultiply')), ...store(3),       // mov eax, [iat]
                ...push('normalize'), ...pushWord(1), ...call('GetProcAddress'), ...store(4),
                0xa1, ...u32(iat('D3DXVec3Normalize')), ...store(5),
                0x68, ...u32(260), ...push('file30'), ...pushWord(0),
                ...call('GetModuleFileNameA'), ...store(6),
                0x68, ...u32(260), ...push('file43'), ...pushWord(1),
                ...call('GetModuleFileNameA'), ...store(7),
                ...push('name36'), ...call('GetModuleHandleA'), ...store(8),
                ...push('name36'), ...call('LoadLibraryA'), ...store(9),
                ...push('multiply'), ...pushWord(9), ...call('GetProcAddress'), ...store(10),
                ...product('out36'), 0xff, 0xd0, ...store(11),              // call eax
                ...pushWord(9), ...call('FreeLibrary'), ...store(12),
                ...push('name36'), ...call('GetModuleHandleA'), ...store(13),
                ...pushWord(0), ...call('FreeLibrary'), ...store(14),
                ...push('name30'), ...call('GetModuleHandleA'), ...store(15),
                ...product('out30'), ...call('D3DXMatrixMultiply'), ...store(16),
                ...push('multiply'), ...pushWord(1), ...call('GetProcAddress'), ...store(17),
                ...product('out43'), 0xff, 0xd0, ...store(18),
                ...push('vector'), ...push('outVector'), ...call('D3DXVec3Normalize'), ...store(19),
                ...push('text'), ...call('atof'), 0x83, 0xc4, 0x04,          // add esp, 4
                0xdd, 0x1d, ...u32(of('number')),                            // fstp qword
                0x6a, 0x00, ...call('ExitProcess'),
            ];
        },
    });
    /** @type {number[]} */
    const expected = [];
    for (let row = 0; row < 4; row++)
    {
        for (let col = 0; col < 4; col++)
        {
            let sum = 0;
            for (let k = 0; k < 4; k++)
            {
                sum += m[row * 4 + k] * n[k * 4 + col];
            }
            expected.push(sum);
        }
    }
    return { executable, at, expected };
}

test('a program importing d3dx9_30, d3dx9_43 and msvcrt finds each and computes', {
    timeout: 60000 }, async t=>{
    const { executable, at, expected } = buildProgram();
    const app = await createApp({ executable, imagePath: 'C:\\App\\Versions.exe' });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 30000 }), 0, 'the program exits 0');

    const bytes = (/** @type {number} */ address, /** @type {number} */ length)=>
        new DataView(Uint8Array.from(app.debug.read(address, length)).buffer);
    const words = bytes(at.words, 20 * 4);
    const w = (/** @type {number} */ i)=>words.getUint32(i * 4, true);
    const sizeOf = (/** @type {number} */ base)=>{
        const header = bytes(base, 0x400);
        return header.getUint32(header.getUint32(0x3c, true) + 0x50, true);
    };
    /** @param {number} address @param {number} base */
    const inside = (address, base)=>address >= base && address < base + sizeOf(base);
    const text = (/** @type {number} */ address, /** @type {number} */ length)=>
        String.fromCharCode(...app.debug.read(address, length));

    const [h30, h43, h36] = [w(0), w(1), w(9)];
    for (const [name, handle] of /** @type {const} */ ([['d3dx9_30', h30], ['d3dx9_43', h43],
        ['d3dx9_36', h36]]))
    {
        assert.notEqual(handle, 0, `${name} has a handle`);
        assert.equal(handle % GRANULE, 0, `${name} is at the allocation granularity`);
    }
    assert.equal(new Set([h30, h43, h36]).size, 3, 'three versions, three modules');

    assert.equal(w(2), w(3), 'd3dx9_30: GetProcAddress answers the address the import got');
    assert.ok(inside(w(2), h30), 'inside d3dx9_30\'s own image');
    assert.equal(w(4), w(5), 'd3dx9_43: GetProcAddress answers the address the import got');
    assert.ok(inside(w(4), h43), 'inside d3dx9_43\'s own image');
    assert.ok(inside(w(17), h43) && w(17) !== w(2),
        'd3dx9_43\'s D3DXMatrixMultiply is its own export, not d3dx9_30\'s');

    assert.match(text(at.file30, w(6)), /\\d3dx9_30\.dll$/i, 'd3dx9_30 names its own file');
    assert.match(text(at.file43, w(7)), /\\d3dx9_43\.dll$/i, 'd3dx9_43 names its own file');

    assert.equal(w(8), 0, 'd3dx9_36 is not loaded before the program loads it');
    assert.ok(inside(w(10), h36) && w(10) !== w(2) && w(10) !== w(17),
        'd3dx9_36\'s export is in d3dx9_36');
    assert.equal(w(11), at.out36, 'the product through d3dx9_36 answers its output');
    assert.equal(w(12), 1, 'freeing d3dx9_36 succeeds');
    assert.equal(w(13), 0, 'and it is gone');
    assert.notEqual(w(14), 0, 'freeing the imported d3dx9_30 answers TRUE');
    assert.equal(w(15), h30, 'and leaves it loaded: an import is pinned');
    assert.equal(w(16), at.out30);
    assert.equal(w(18), at.out43);
    assert.equal(w(19), at.outVector);

    for (const out of ['out30', 'out36', 'out43'])
    {
        const product = bytes(at[out], 64);
        assert.deepEqual(expected.map((_, i)=>product.getFloat32(i * 4, true)), expected,
            `the product in ${out}`);
    }
    const vector = bytes(at.outVector, 12);
    assert.deepEqual([0, 1, 2].map(i=>vector.getFloat32(i * 4, true)),
        [Math.fround(0.6), 0, Math.fround(-0.8)], 'the vector normalised');
    assert.equal(bytes(at.number, 8).getFloat64(0, true), 2500, 'atof read its number');
});
