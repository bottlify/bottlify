/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DERR_INVALIDCALL, D3D_OK } from './constants.js';
import { createReferenceCount } from './resources.js';
import {
    D3DDECLMETHOD, D3DDECLTYPE, D3DDECLUSAGE, MAX_DECLARATION_LENGTH,
    createVertexDeclaration, declarationEnd, elementsOfFvf, fixedFunctionLayoutOf, fvfOfElements,
    strideOf,
    validateElements,
} from './declaration.js';

const FVF_XYZ = 0x002;
const FVF_XYZRHW = 0x004;
const FVF_XYZB3 = 0x00a;
const FVF_NORMAL = 0x010;
const FVF_DIFFUSE = 0x040;
const FVF_SPECULAR = 0x080;
const FVF_TEX1 = 0x100;
const FVF_TEX2 = 0x200;
const FVF_LASTBETA_UBYTE4 = 0x1000;
/** D3DFVF_TEXCOORDSIZE1(1): one float for the second set. */
const FVF_TEXCOORDSIZE1_SET1 = 3 << 18;

/**
 * @param {number} usage @param {number} type @param {number} offset
 * @param {{ stream?: number, index?: number, method?: number }} [rest]
 */
const element = (usage, type, offset, rest = {})=>({
    Stream: rest.stream ?? 0,
    Offset: offset,
    Type: type,
    Method: rest.method ?? D3DDECLMETHOD.DEFAULT,
    Usage: usage,
    UsageIndex: rest.index ?? 0,
});

test('a format becomes its elements in the order the format lays them out', ()=>{
    const elements = elementsOfFvf(FVF_XYZ | FVF_NORMAL | FVF_DIFFUSE | FVF_SPECULAR | FVF_TEX2
        | FVF_TEXCOORDSIZE1_SET1);
    assert.deepEqual(elements, [
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.NORMAL, D3DDECLTYPE.FLOAT3, 12),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 24),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 28, { index: 1 }),
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 32),
        // The two-bit size code three is one float, not four.
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT1, 40, { index: 1 }),
    ]);
    assert.equal(strideOf(elements ?? [], 0), 44);
});

test('a pre-transformed position is a POSITIONT of four floats', ()=>{
    assert.deepEqual(elementsOfFvf(FVF_XYZRHW | FVF_DIFFUSE | FVF_TEX1), [
        element(D3DDECLUSAGE.POSITIONT, D3DDECLTYPE.FLOAT4, 0),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 16),
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 20),
    ]);
});

test('blend weights follow the position, and a last beta of indices is its own element', ()=>{
    assert.deepEqual(elementsOfFvf(FVF_XYZB3 | FVF_LASTBETA_UBYTE4), [
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.BLENDWEIGHT, D3DDECLTYPE.FLOAT2, 12),
        element(D3DDECLUSAGE.BLENDINDICES, D3DDECLTYPE.UBYTE4, 20),
    ]);
    assert.deepEqual(elementsOfFvf(FVF_XYZB3), [
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.BLENDWEIGHT, D3DDECLTYPE.FLOAT3, 12),
    ]);
});

test('the conversion round-trips for every format a fixed-function draw can read', ()=>{
    for (const fvf of [
        FVF_XYZ, FVF_XYZ | FVF_NORMAL, FVF_XYZ | FVF_DIFFUSE | FVF_TEX1,
        FVF_XYZRHW | FVF_DIFFUSE | FVF_SPECULAR | FVF_TEX2, FVF_XYZB3 | FVF_LASTBETA_UBYTE4,
        FVF_XYZ | FVF_NORMAL | FVF_TEX2 | FVF_TEXCOORDSIZE1_SET1, 0x4002 | FVF_DIFFUSE,
    ])
    {
        const elements = elementsOfFvf(fvf);
        assert.ok(elements, `${fvf.toString(16)} converts`);
        assert.equal(fvfOfElements(elements), fvf, `${fvf.toString(16)} round-trips`);
    }
});

test('elements that describe no format have no format', ()=>{
    // A second stream, a tangent, a gap, a set out of order: each is a vertex
    // no format can name, and a draw that needs one must not be handed a
    // near miss.
    assert.equal(fvfOfElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.NORMAL, D3DDECLTYPE.FLOAT3, 0, { stream: 1 }),
    ]), 0);
    assert.equal(fvfOfElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.TANGENT, D3DDECLTYPE.FLOAT3, 12),
    ]), 0);
    assert.equal(fvfOfElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.NORMAL, D3DDECLTYPE.FLOAT3, 16),
    ]), 0);
    assert.equal(fvfOfElements([
        element(D3DDECLUSAGE.NORMAL, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 12),
    ]), 0);
    assert.equal(fvfOfElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.SHORT2, 12),
    ]), 0);
});

test('validation refuses what the header puts out of range', ()=>{
    const good = [element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0)];
    assert.equal(validateElements(good), D3D_OK);
    assert.equal(validateElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0, { stream: 16 }),
    ]), D3DERR_INVALIDCALL, 'a stream past the last');
    assert.equal(validateElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.UNUSED, 0),
    ]), D3DERR_INVALIDCALL, 'the unused type outside the sentinel');
    assert.equal(validateElements([
        element(D3DDECLUSAGE.POSITION, 18, 0),
    ]), D3DERR_INVALIDCALL, 'a type past the last');
    assert.equal(validateElements([
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0, { method: 7 }),
    ]), D3DERR_INVALIDCALL, 'a method past the last');
    assert.equal(validateElements([
        element(14, D3DDECLTYPE.FLOAT3, 0),
    ]), D3DERR_INVALIDCALL, 'a usage past the last');
    for (const offset of [1, 2, 3, 6])
    {
        assert.equal(validateElements([
            element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
            element(D3DDECLUSAGE.NORMAL, D3DDECLTYPE.FLOAT3, 12 + offset),
        ]), D3DERR_INVALIDCALL, `an offset of ${12 + offset} is not dword-aligned`);
    }
    assert.equal(validateElements([
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 0),
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 8),
    ]), D3DERR_INVALIDCALL, 'the same usage and index twice');
    assert.equal(validateElements([
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 0),
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 8, { index: 1 }),
    ]), D3D_OK, 'the same usage at two indices');
    assert.equal(validateElements(Array.from({ length: MAX_DECLARATION_LENGTH + 1 },
        (_, index)=>element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT1, index * 4,
            { index }))), D3DERR_INVALIDCALL, 'more elements than a declaration holds');
});

test('a declaration reads back with its sentinel', ()=>{
    const elements = [
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 12),
    ];
    const declaration = createVertexDeclaration({ elements, count: createReferenceCount() });

    /** @type {{ elements?: any[], count?: number }} */
    let out = {};
    assert.equal(declaration.GetDeclaration(out), D3D_OK);
    assert.equal(out.count, 3, 'the count includes the sentinel');
    assert.equal(out.elements, undefined, 'asking for the count copies nothing');

    out = {};
    assert.equal(declaration.GetDeclaration(out, true), D3D_OK);
    assert.equal(out.count, 3);
    assert.deepEqual(out.elements, [...elements, declarationEnd()]);

    // What was made from is not what the elements happen to describe.
    assert.equal(declaration.fvf, 0);
    assert.equal(declaration.release(), 0);
});

test('fixed function reads a declaration by its offsets and refuses what it cannot', ()=>{
    const position = element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 16);
    const layout = fixedFunctionLayoutOf({ id: 7, elements: [
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 0),
        element(D3DDECLUSAGE.TANGENT, D3DDECLTYPE.FLOAT3, 8),
        position,
    ] });
    assert.deepEqual(layout, {
        id: 7,
        attributes: [
            { name: 'texCoord0', offset: 0, format: 'float32x2', bytes: 8, stream: 0 },
            { name: 'position', offset: 16, format: 'float32x3', bytes: 12, stream: 0 },
        ],
        preTransformed: false,
        texCoordSets: 1,
        streams: [],
    }, 'the tangent is ignored and the rest read where they lie');
    // A member in another stream is read from that stream (Wine's d3d9
    // test_color_vertex draws the colours from streams 1 and 2).
    const split = fixedFunctionLayoutOf({ id: 8, elements: [
        element(D3DDECLUSAGE.POSITION, D3DDECLTYPE.FLOAT3, 0),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 0, { stream: 2 }),
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.D3DCOLOR, 4, { stream: 1, index: 1 }),
    ] });
    assert.deepEqual(split?.attributes.map(attribute=>[attribute.name, attribute.stream]),
        [['position', 0], ['diffuse', 2], ['specular', 1]]);
    assert.deepEqual(split?.streams, [1, 2]);
    assert.equal(fixedFunctionLayoutOf({ id: 1, elements: [position,
        element(D3DDECLUSAGE.BLENDWEIGHT, D3DDECLTYPE.FLOAT1, 28)] }), null, 'blend weights');
    assert.equal(fixedFunctionLayoutOf({ id: 1, elements: [position,
        element(D3DDECLUSAGE.TEXCOORD, D3DDECLTYPE.FLOAT2, 28, { index: 1 })] }), null,
    'a gap in the sets');
    assert.equal(fixedFunctionLayoutOf({ id: 1, elements: [position,
        element(D3DDECLUSAGE.COLOR, D3DDECLTYPE.UBYTE4N, 28)] }), null, 'a colour in R, G, B, A');
    assert.equal(fixedFunctionLayoutOf({ id: 1, elements: [
        element(D3DDECLUSAGE.NORMAL, D3DDECLTYPE.FLOAT3, 0)] }), null, 'no position');
});
