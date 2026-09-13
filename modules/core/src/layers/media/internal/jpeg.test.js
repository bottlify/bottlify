/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The decoder against streams built here from coefficients, with Huffman
 * tables of this file's own: no fixture from anywhere, and the expected
 * picture computed from the definition of the transform rather than taken
 * on trust from another decoder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJpeg, readJpegHeader } from './jpeg.js';
import { FLAT, block, encode, reference } from './jpeg.fixture.js';

test('a flat block decodes to its DC level', ()=>{
    // DC 40 with a quantiser of 1: every sample is 40 / 8 + 128 = 133.
    const bytes = encode({ width: 8, height: 8, quant: FLAT,
        components: [{ h: 1, v: 1, blocks: [block(40)] }] });
    const image = decodeJpeg(bytes);
    assert.equal(image.width, 8);
    assert.equal(image.height, 8);
    assert.equal(image.components, 1);
    assert.deepEqual([...new Set(image.samples)], [133]);
});

test('AC coefficients come out as the transform defines them', ()=>{
    const quant = FLAT.map((_, i)=>1 + (i % 5));
    const blocks = [
        block(-30, [[1, 12], [8, -7], [9, 3], [18, 5], [63, -2]]),
        block(25, [[2, -9], [16, 4], [3, 1], [40, 6]]),
    ];
    const bytes = encode({ width: 16, height: 8, quant, components: [{ h: 1, v: 1, blocks }] });
    const image = decodeJpeg(bytes);
    assert.equal(image.width, 16);
    blocks.forEach((b, index)=>{
        const expected = reference(b, quant);
        for (let y = 0; y < 8; y++)
        {
            for (let x = 0; x < 8; x++)
            {
                const got = image.samples[y * 16 + index * 8 + x];
                assert.ok(Math.abs(got - expected[y * 8 + x]) <= 1,
                    `block ${index} (${x},${y}): ${got} vs ${expected[y * 8 + x]}`);
            }
        }
    });
});

/**
 * The transform takes a different route through a block depending on how much
 * of it survived quantisation -- an empty block, a block with only a DC term, a
 * row of coefficients that is entirely zero -- because a term that is exactly
 * zero is left out of the sum instead of being added to it. Leaving it out is
 * supposed to be free of consequence, so these are exact bytes rather than the
 * tolerance the check against the definition can afford: a route that drifts by
 * one has changed every texture in the game, and a tolerance would not say so.
 */
/** @type {[string, number[], number[], number[]][]} A name, a block, its quantiser, one row. */
const PATHS = [
    ['a block with nothing in it', block(0), FLAT, [
        128, 128, 128, 128, 128, 128, 128, 128,
    ]],
    ['a block with only a DC term', block(48), FLAT, [
        134, 134, 134, 134, 134, 134, 134, 134,
    ]],
    ['one AC term in the first row', block(0, [[1, 40]]), FLAT, [
        135, 134, 132, 129, 127, 124, 122, 121,
    ]],
];

for (const [name, coefficients, quant, firstRow] of PATHS)
{
    test(`${name} transforms to exactly the same bytes as ever`, ()=>{
        const bytes = encode({ width: 8, height: 8, quant,
            components: [{ h: 1, v: 1, blocks: [coefficients] }] });
        const samples = decodeJpeg(bytes).samples;
        // Each of these has a constant column, so one row pins the whole block.
        for (let y = 0; y < 8; y++)
        {
            assert.deepEqual([...samples.subarray(y * 8, y * 8 + 8)], firstRow, `row ${y}`);
        }
    });
}

test('a block whose coefficients are all present transforms to exactly the same bytes as ever',
    ()=>{
        // The route with nothing skipped, so the two paths are pinned against
        // each other as well as against themselves.
        const quant = FLAT.map((_, i)=>1 + (i % 7));
        const coefficients = Array.from({ length: 64 }, (_, i)=>((i * 7) % 23) - 11);
        const bytes = encode({ width: 8, height: 8, quant,
            components: [{ h: 1, v: 1, blocks: [coefficients] }] });
        assert.deepEqual([...decodeJpeg(bytes).samples], [
            129, 105, 130, 133, 109, 144, 162, 120,
            143, 114, 146, 150, 91, 166, 129, 98,
            151, 97, 139, 124, 138, 158, 97, 89,
            104, 106, 117, 152, 148, 87, 131, 127,
            155, 84, 151, 90, 125, 152, 112, 151,
            142, 166, 127, 108, 121, 81, 107, 147,
            120, 149, 96, 93, 40, 169, 128, 106,
            118, 131, 136, 75, 183, 225, 130, 149,
        ]);
    });

test('a sparse block transforms to exactly the same bytes as ever', ()=>{
    // Low-frequency corner only: some rows of the transform are empty and some
    // are not, which is the mixture a photograph actually produces.
    const quant = FLAT.map((_, i)=>1 + (i % 5));
    const bytes = encode({ width: 8, height: 8, quant,
        components: [{ h: 1, v: 1, blocks: [block(-24, [[1, 11], [8, -9], [9, 4], [2, -3]])] }] });
    assert.deepEqual([...decodeJpeg(bytes).samples], [
        126, 125, 124, 122, 119, 114, 111, 109,
        126, 126, 125, 123, 120, 116, 112, 110,
        127, 126, 126, 124, 122, 118, 115, 113,
        127, 127, 127, 126, 124, 122, 119, 118,
        128, 128, 128, 128, 127, 125, 123, 122,
        128, 129, 130, 130, 130, 129, 127, 126,
        129, 129, 131, 132, 132, 131, 130, 129,
        129, 130, 131, 133, 133, 132, 131, 131,
    ]);
});

test('four components interleave in the frame order, untouched', ()=>{
    // A texture library stores its four channels as four components; what
    // it wants back is those channels in that order, not a colour space.
    const components = [10, 20, 30, 40].map(dc=>({ h: 1, v: 1, blocks: [block(dc * 8)] }));
    const image = decodeJpeg(encode({ width: 8, height: 8, quant: FLAT, components }));
    assert.equal(image.components, 4);
    assert.deepEqual([...image.samples.subarray(0, 8)], [138, 148, 158, 168, 138, 148, 158, 168]);
    assert.equal(image.samples.length, 8 * 8 * 4);
});

test('a subsampled component is spread over the frame', ()=>{
    // Luma at 2x2 blocks per MCU, chroma at one: the chroma sample covers a
    // 2x2 patch of the picture.
    const luma = { h: 2, v: 2, blocks: [block(0), block(80), block(-80), block(0)] };
    const chroma = { h: 1, v: 1, blocks: [block(16)] };
    const image = decodeJpeg(encode({ width: 16, height: 16, quant: FLAT,
        components: [luma, chroma] }));
    assert.equal(image.width, 16);
    assert.equal(image.samples.length, 16 * 16 * 2);
    assert.equal(image.samples[(0 * 16 + 0) * 2], 128, 'first luma block');
    assert.equal(image.samples[(0 * 16 + 8) * 2], 138, 'second');
    assert.equal(image.samples[(8 * 16 + 0) * 2], 118, 'third');
    assert.deepEqual([...new Set([...image.samples].filter((_, i)=>i % 2 === 1))], [130],
        'chroma everywhere');
});

test('a restart interval resets the predictors and skips the marker', ()=>{
    const blocks = [block(50), block(50), block(-50), block(-50)];
    const bytes = encode({ width: 32, height: 8, quant: FLAT, restart: 2,
        components: [{ h: 1, v: 1, blocks }] });
    assert.ok(bytes.some((b, i)=>b === 0xff && bytes[i + 1] === 0xd0), 'an RST0 was written');
    const image = decodeJpeg(bytes);
    assert.deepEqual([image.samples[0], image.samples[8], image.samples[16], image.samples[24]],
        [134, 134, 122, 122]);
});

test('the header can be read without decoding, and progressive coding is refused', ()=>{
    const bytes = encode({ width: 24, height: 8, quant: FLAT,
        components: [{ h: 1, v: 1, blocks: [block(0), block(0), block(0)] }] });
    assert.deepEqual(readJpegHeader(bytes), { width: 24, height: 8, components: 1 });
    const progressive = encode({ width: 8, height: 8, quant: FLAT, sof: 0xc2,
        components: [{ h: 1, v: 1, blocks: [block(0)] }] });
    assert.throws(()=>decodeJpeg(progressive), /sequential/);
    assert.throws(()=>decodeJpeg(Uint8Array.of(1, 2, 3, 4)), /not a JPEG/);
});
