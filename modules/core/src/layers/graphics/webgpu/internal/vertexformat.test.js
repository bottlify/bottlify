/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FVF, decodeFvf } from './vertexformat.js';

/** Two texture coordinate sets, both the default two floats. */
const twoSets = 2 << FVF.TEXCOUNT_SHIFT;

test('the attribute order is the API\'s, not the bit order', ()=>{
    // The bits say which attributes exist and nothing about where they sit; the
    // order is fixed by the API. Reading it off the bit positions instead puts
    // every attribute after the first mistake at the wrong offset, which draws
    // geometry rather than failing.
    const layout = decodeFvf(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE | FVF.SPECULAR | twoSets);

    assert.deepEqual(layout.attributes.map(attribute=>attribute.name),
        ['position', 'normal', 'diffuse', 'specular', 'texCoord0', 'texCoord1']);
    assert.deepEqual(layout.attributes.map(attribute=>attribute.offset),
        [0, 12, 24, 28, 32, 40]);
    assert.equal(layout.stride, 48);
});

test('every attribute lies inside the stride, and none overlaps another', ()=>{
    // The property that matters whatever the format: a decoder that gets one
    // size wrong produces attributes that overlap or run off the end, and both
    // read a neighbour's bytes rather than reporting anything.
    const formats = [
        FVF.XYZ,
        FVF.XYZRHW | FVF.DIFFUSE,
        FVF.XYZ | FVF.NORMAL,
        FVF.XYZB3 | FVF.NORMAL | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        FVF.XYZ | FVF.PSIZE | FVF.SPECULAR | twoSets,
    ];

    for (const fvf of formats)
    {
        const layout = decodeFvf(fvf);
        let end = 0;
        for (const attribute of layout.attributes)
        {
            assert.equal(attribute.offset, end,
                `0x${fvf.toString(16)}: ${attribute.name} does not follow its predecessor`);
            end += sizeOf(attribute.format);
        }
        assert.equal(layout.stride, end, `0x${fvf.toString(16)}: stride covers every attribute`);
    }
});

test('a pre-transformed position carries four floats and says so', ()=>{
    // XYZRHW is already in screen space. A pipeline that transforms it anyway
    // puts the geometry somewhere else entirely, so the fact has to travel with
    // the layout rather than being re-derived from the bits.
    const plain = decodeFvf(FVF.XYZ);
    const transformed = decodeFvf(FVF.XYZRHW);

    assert.equal(plain.preTransformed, false);
    assert.equal(plain.attributes[0].format, 'float32x3');
    assert.equal(transformed.preTransformed, true);
    assert.equal(transformed.attributes[0].format, 'float32x4');
});

test('a texture coordinate pair of three means one float, not four', ()=>{
    // The encoding is not a count: 0,1,2,3 mean 2,3,4,1 floats. Read as a count
    // it takes a one-dimensional coordinate for a four-dimensional one and
    // every later attribute moves.
    const sizes = [
        [0, 'float32x2', 8],
        [1, 'float32x3', 12],
        [2, 'float32x4', 16],
        [3, 'float32', 4],
    ];

    for (const [bits, format, bytes] of sizes)
    {
        const layout = decodeFvf(
            FVF.XYZ | (1 << FVF.TEXCOUNT_SHIFT) | (Number(bits) << 16));
        assert.equal(layout.attributes[1].format, format);
        assert.equal(layout.stride, 12 + Number(bytes));
    }
});

test('blend weights come from the position field and follow the position', ()=>{
    for (const [fvf, weights] of [[FVF.XYZB1, 1], [FVF.XYZB3, 3], [FVF.XYZB5, 5]])
    {
        const layout = decodeFvf(fvf);
        assert.equal(layout.blendWeights, weights);
        assert.equal(layout.attributes[1].name, 'blendWeight');
        assert.equal(layout.attributes[1].offset, 12, 'immediately after the position');
        assert.equal(layout.stride, 12 + weights * 4);
    }
});

test('a colour is four bytes, and the swizzle is somebody else\'s problem', ()=>{
    // Recorded here because the format is what makes it necessary: unorm8x4
    // reads the DWORD in memory order, so it arrives b,g,r,a and the shader
    // puts it back. Missing that is a picture with red and blue exchanged.
    const layout = decodeFvf(FVF.XYZ | FVF.DIFFUSE);
    assert.equal(layout.attributes[1].format, 'unorm8x4');
    assert.equal(layout.stride, 16);
});

test('a format with no position is refused rather than half-decoded', ()=>{
    assert.throws(()=>decodeFvf(FVF.DIFFUSE), /declares no position/);
});

/** @param {string} format */
function sizeOf(format){
    if (format === 'unorm8x4' || format === 'float32')
    {
        return 4;
    }
    return Number(format.slice('float32x'.length)) * 4;
}
