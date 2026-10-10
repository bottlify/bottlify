/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeclarationFunctions, declarationBytes, declaratorFromFvf, declVertexSize,
    fvfFromDeclarator, readDeclaration } from './fvf.js';
import { D3DXGetFVFVertexSize } from './inguest.js';

/** A declaration as rows: offset, type, usage, usage index (stream 0, method 0). */
const rows = (/** @type {number} */ fvf)=>declaratorFromFvf(fvf)?.map(e=>[e.offset, e.type,
    e.usage, e.usageIndex]) ?? null;

test('an FVF declares its parts in the documented order, each where the one before ends', ()=>{
    // XYZ | NORMAL | DIFFUSE | TEX2, the second set of three floats.
    assert.deepEqual(rows(0x2 | 0x10 | 0x40 | 0x200 | 1 << 18), [[0, 2, 0, 0], [12, 2, 3, 0],
        [24, 4, 10, 0], [28, 1, 5, 0], [36, 2, 5, 1]]);
    assert.deepEqual(rows(0x4 | 0x40 | 0x80), [[0, 3, 9, 0], [16, 4, 10, 0], [20, 4, 10, 1]],
        'XYZRHW is POSITIONT; the specular colour is the second');
    assert.deepEqual(rows(0x4002 | 0x20), [[0, 3, 0, 0], [16, 0, 4, 0]], 'XYZW, PSIZE');
    assert.deepEqual(rows(0xa), [[0, 2, 0, 0], [12, 2, 1, 0]], 'XYZB3: three weights');
    assert.deepEqual(rows(0xc | 0x1000), [[0, 2, 0, 0], [12, 2, 1, 0], [24, 5, 2, 0]],
        'XYZB4 with UBYTE4 indices: three weights and the indices');
    assert.deepEqual(rows(0x6 | 0x8000), [[0, 2, 0, 0], [12, 4, 2, 0]],
        'XYZB1 whose one beta is D3DCOLOR indices');
    assert.equal(rows(0xe), null, 'five weights are no one element');
    assert.deepEqual(rows(0), [], 'nothing at all');
});

test('every FVF a declaration has comes back from it, at the size D3DXGetFVFVertexSize gives',
    ()=>{
        for (const fvf of [0x2, 0x12, 0x52, 0x152, 0x2d2, 0x4, 0x44, 0x4002, 0x6 | 0x1000,
            0xa, 0xc | 0x8000, 0x112 | 3 << 16, (0x822 | 0xaaaa << 16) >>> 0])
        {
            const elements = /** @type {any[]} */ (declaratorFromFvf(fvf));
            assert.equal(fvfFromDeclarator(elements), fvf, fvf.toString(16));
            assert.equal(declVertexSize(elements, 0), D3DXGetFVFVertexSize(fvf),
                fvf.toString(16));
        }
    });

test('a declaration no FVF lays out has none', ()=>{
    const position = { stream: 0, offset: 0, type: 2, method: 0, usage: 0, usageIndex: 0 };
    const normal = { stream: 0, offset: 12, type: 2, method: 0, usage: 3, usageIndex: 0 };
    assert.equal(fvfFromDeclarator([position, normal]), 0x12);
    assert.equal(fvfFromDeclarator([normal, { ...position, offset: 12 }].map((e, i)=>
        ({ ...e, offset: i * 12 }))), null, 'the normal before the position');
    assert.equal(fvfFromDeclarator([position, { ...normal, offset: 16 }]), null, 'a gap');
    assert.equal(fvfFromDeclarator([position, { ...normal, usage: 6 }]), null, 'a tangent');
    assert.equal(fvfFromDeclarator([position, { ...normal, stream: 1, offset: 0 }]), null);
});

test('the exports read and write declarations in guest memory, up to D3DDECL_END', ()=>{
    const memory = new Uint8Array(0x1000);
    const fns = createDeclarationFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
    });
    assert.equal(fns.D3DXDeclaratorFromFVF.handler([0x152, 0x100]), 0);
    assert.deepEqual([...memory.subarray(0x100 + 32, 0x100 + 40)], [0xff, 0, 0, 0, 17, 0, 0, 0],
        'D3DDECL_END after the four elements');
    assert.equal(fns.D3DXGetDeclLength.handler([0x100]), 4);
    assert.equal(fns.D3DXGetDeclVertexSize.handler([0x100, 0]), 36);
    assert.equal(fns.D3DXGetDeclVertexSize.handler([0x100, 1]), 0);
    assert.equal(fns.D3DXFVFFromDeclarator.handler([0x100, 0x800]), 0);
    assert.equal(new DataView(memory.buffer).getUint32(0x800, true), 0x152);
    assert.equal(fns.D3DXDeclaratorFromFVF.handler([0xe, 0x100]) >>> 0, 0x8876086c);
    assert.equal(fns.D3DXFVFFromDeclarator.handler([0, 0x800]) >>> 0, 0x8876086c);
    assert.deepEqual(readDeclaration((at, length)=>memory.subarray(at, at + length), 0x100),
        declaratorFromFvf(0x152));
    assert.deepEqual([...declarationBytes([])], [0xff, 0, 0, 0, 17, 0, 0, 0]);
});
