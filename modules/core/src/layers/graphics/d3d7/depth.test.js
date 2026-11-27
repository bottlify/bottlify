/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthLayout, packDepths, unpackDepths } from './depth.js';

/**
 * The formats Wine's ddraw7 test_depth_readback makes, as DirectDraw keeps
 * them: depth bits, depth mask, stencil mask, and bytes a pixel.
 */
const FORMATS = [
    { name: 'D16', bitCount: 16, greenMask: 0xffff, blueMask: 0, bytes: 2 },
    { name: 'D24 in three bytes', bitCount: 24, greenMask: 0xffffff, blueMask: 0, bytes: 3 },
    { name: 'D24X8', bitCount: 32, greenMask: 0xffffff, blueMask: 0, bytes: 4 },
    { name: 'D24S8', bitCount: 32, greenMask: 0xffffff, blueMask: 0xff000000, bytes: 4 },
    { name: 'D32', bitCount: 32, greenMask: 0xffffffff, blueMask: 0, bytes: 4 },
];

/** @param {Uint8Array} bytes @param {number} at @param {number} width */
const pixelAt = (bytes, at, width)=>{
    let value = 0;
    for (let byte = 0; byte < width; byte++)
    {
        value += bytes[at + byte] * 2 ** (8 * byte);
    }
    return value;
};

test('a depth is its share of the depth mask\'s range, in the pixel\'s own bytes', ()=>{
    for (const format of FORMATS)
    {
        const pixels = { width: 3, height: 2, pitch: 3 * format.bytes + 5,
            bytesPerPixel: format.bytes };
        const bytes = new Uint8Array(pixels.pitch * 2).fill(0xaa);
        const depths = Float32Array.from([0, 0.125, 1, 0.5, 0.25, 0.75]);
        const stencils = Uint8Array.from([1, 2, 3, 4, 5, 0xff]);
        packDepths(bytes, pixels, format, depths, stencils);
        const range = format.greenMask >>> 0;
        depths.forEach((depth, index)=>{
            const at = Math.floor(index / 3) * pixels.pitch + (index % 3) * format.bytes;
            const value = pixelAt(bytes, at, format.bytes);
            const expected = Math.round(depth * range)
                + (format.blueMask ? stencils[index] * 2 ** 24 : 0);
            assert.equal(value, expected, `${format.name} pixel ${index}`);
        });
        assert.equal(bytes[3 * format.bytes], 0xaa, `${format.name}: the row's padding is left`);
        const back = unpackDepths(bytes, pixels, format);
        assert.deepEqual([...back.depths].map(depth=>Math.round(depth * 1e4) / 1e4),
            [...depths], `${format.name} reads back its depths`);
        assert.deepEqual(back.stencils && [...back.stencils],
            format.blueMask ? [...stencils] : null, `${format.name} and its stencils`);
    }
});

test('the masks say where depth and stencil sit; with none named, the bit count does', ()=>{
    assert.deepEqual(depthLayout({ bitCount: 32, greenMask: 0xffffff00, blueMask: 0xff }),
        { depthShift: 8, depthRange: 0xffffff, stencilShift: 0, stencilRange: 0xff });
    assert.deepEqual(depthLayout({ bitCount: 16, greenMask: 0, blueMask: 0 }),
        { depthShift: 0, depthRange: 0xffff, stencilShift: 0, stencilRange: 0 });
    const bytes = new Uint8Array(4);
    packDepths(bytes, { width: 1, height: 1, pitch: 4, bytesPerPixel: 4 },
        { bitCount: 32, greenMask: 0xffffff00, blueMask: 0xff }, Float32Array.of(1),
        Uint8Array.of(7));
    assert.deepEqual([...bytes], [7, 0xff, 0xff, 0xff], 'the stencil low, the depth above it');
});
