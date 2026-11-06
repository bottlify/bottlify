/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * S3TC/DXTn block decoding: every expectation is a byte, so a change to the
 * arithmetic is a changed picture that these tests exist to notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressedBytes, decodeS3tc, encodeS3tc } from './s3tc.js';

/**
 * A result that must be there: the test says so before it reads it.
 *
 * @template T
 * @param {T | null} value
 * @returns {T}
 */
function some(value){
    assert.notEqual(value, null);
    return /** @type {T} */ (value);
}

test('a DXT1 block decodes its two colours, their two blends, and its transparent index', ()=>{
    // colour0 = pure red in 5-6-5 (0xf800), colour1 = pure blue (0x001f).
    // colour0 > colour1, so four colours are interpolated. The index word
    // walks 0, 1, 2, 3 across the first row and is 0 elsewhere.
    const block = new Uint8Array(8);
    const view = new DataView(block.buffer);
    view.setUint16(0, 0xf800, true);
    view.setUint16(2, 0x001f, true);
    view.setUint32(4, 0b11100100, true);
    assert.equal(compressedBytes('dxt1', 4, 4), 8);
    const texels = some(decodeS3tc(block, 'dxt1', 4, 4));
    const texel = (/** @type {number} */ i)=>[...texels.subarray(i * 4, i * 4 + 4)];
    assert.deepEqual(texel(0), [255, 0, 0, 255]);
    assert.deepEqual(texel(1), [0, 0, 255, 255]);
    assert.deepEqual(texel(2), [170, 0, 85, 255], 'two thirds of colour0');
    assert.deepEqual(texel(3), [85, 0, 170, 255], 'one third');

    // With colour0 <= colour1 the block has three colours and index 3 is
    // transparent black -- a caller with no alpha channel at all conforms it
    // to opaque afterward, the way every other alpha-less format is.
    view.setUint16(0, 0x001f, true);
    view.setUint16(2, 0xf800, true);
    const decoded = some(decodeS3tc(block, 'dxt1', 4, 4));
    assert.deepEqual([...decoded.subarray(8, 12)], [128, 0, 128, 255], 'the midpoint');
    assert.deepEqual([...decoded.subarray(12, 16)], [0, 0, 0, 0]);

    // A 2x2 image is still one block, and only its corner is kept.
    assert.equal(compressedBytes('dxt1', 2, 2), 8);
    assert.equal(some(decodeS3tc(block, 'dxt1', 2, 2)).length, 16);
    assert.equal(decodeS3tc(block, 'dxt1', 8, 8), null, 'too few bytes');
});

test('DXT3 carries explicit alpha nibbles and DXT5 interpolates eight', ()=>{
    const block = new Uint8Array(16);
    const view = new DataView(block.buffer);
    // DXT3: the first texel's nibble is 0xf, the second's 0x8.
    view.setUint16(0, 0x008f, true);
    view.setUint16(8, 0xffff, true);
    view.setUint16(10, 0xffff, true);
    const dxt3 = some(decodeS3tc(block, 'dxt3', 4, 4));
    assert.deepEqual([...dxt3.subarray(0, 4)], [255, 255, 255, 255]);
    assert.deepEqual([...dxt3.subarray(4, 8)], [255, 255, 255, 136]);
    assert.deepEqual([...dxt3.subarray(8, 12)], [255, 255, 255, 0]);

    // DXT5: alpha0 = 255, alpha1 = 0, so the table is 255, 0, 219, 182, ...;
    // the first texel's three index bits are 0b010, the second's 0b001.
    block.fill(0);
    block[0] = 255;
    block[1] = 0;
    block[2] = 0b001010;
    view.setUint16(8, 0xffff, true);
    view.setUint16(10, 0xffff, true);
    const dxt5 = some(decodeS3tc(block, 'dxt5', 4, 4));
    assert.equal(dxt5[3], 219, '(6 * 255 + 1 * 0) / 7');
    assert.equal(dxt5[7], 0, 'index one is alpha1');
    assert.equal(dxt5[11], 255, 'index zero is alpha0');
});

/**
 * A DXT5 alpha block: two endpoints and sixteen 3-bit indices, the bits packed
 * low bits first as the S3TC specification writes them, so a field straddles a
 * byte wherever 3i crosses a multiple of eight.
 *
 * @param {number} a0
 * @param {number} a1
 * @param {number[]} indices
 * @returns {Uint8Array}
 */
function dxt5Block(a0, a1, indices){
    const block = new Uint8Array(16);
    block[0] = a0;
    block[1] = a1;
    for (let i = 0; i < 16; i++)
    {
        const bit = i * 3;
        block[2 + (bit >> 3)] |= (indices[i] & 7) << (bit & 7);
        if ((bit & 7) > 5)
        {
            block[3 + (bit >> 3)] |= (indices[i] & 7) >> (8 - (bit & 7));
        }
    }
    const view = new DataView(block.buffer);
    view.setUint16(8, 0xf800, true);
    view.setUint16(10, 0x001f, true);
    view.setUint32(12, 0, true);
    return block;
}

test('every DXT5 alpha index reads its own table entry, through the byte straddles', ()=>{
    // S3TC: alpha0 > alpha1 selects the eight-entry table (six interpolated
    // steps); alpha0 <= alpha1 the six-entry table with 0 and 255 appended.
    // The index pattern walks 0..7 twice, so every entry is read and the fields
    // at texels 2, 5..7, 10 and 13..15 straddle a byte. The tables are written
    // out as the specification's rounded values, independent of the reader.
    const indices = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
    /** @type {[number, number, number[]][]} */
    const cases = [
        [255, 0, [255, 0, 219, 182, 146, 109, 73, 36]],
        [0, 255, [0, 255, 51, 102, 153, 204, 0, 255]],
        [200, 100, [200, 100, 186, 171, 157, 143, 129, 114]],
    ];
    for (const [a0, a1, table] of cases)
    {
        const texels = some(decodeS3tc(dxt5Block(a0, a1, indices), 'dxt5', 4, 4));
        for (let i = 0; i < 16; i++)
        {
            assert.equal(texels[i * 4 + 3], table[indices[i]],
                `texel ${i}: index ${indices[i]} of the table for (${a0}, ${a1})`);
            assert.deepEqual([...texels.subarray(i * 4, i * 4 + 3)], [255, 0, 0],
                `texel ${i}: the alpha block leaves the colour alone`);
        }
    }
});

test('decoded into bytes the caller gives, the texels are those bytes and the same texels', ()=>{
    // Random bytes are a valid image in every format, and cover both colour
    // modes and both alpha tables; the shapes cover the partial blocks.
    let seed = 7;
    const next = ()=>(seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    for (const kind of /** @type {const} */ (['dxt1', 'dxt3', 'dxt5']))
    {
        for (const [width, height] of [[1, 1], [3, 5], [4, 4], [13, 7], [32, 16]])
        {
            const bytes = Uint8Array.from({ length: compressedBytes(kind, width, height) }, next);
            const fresh = some(decodeS3tc(bytes, kind, width, height));
            const into = new Uint8Array(width * height * 4 + 8).fill(0xcd);
            const placed = some(decodeS3tc(bytes, kind, width, height, into));
            assert.equal(placed.buffer, into.buffer,
                `${kind} ${width}x${height}: in the bytes given`);
            assert.deepEqual([...placed], [...fresh], `${kind} ${width}x${height}`);
            assert.equal(into[width * height * 4], 0xcd, 'and nothing past them');
        }
    }
    const short = new Uint8Array(15);
    const decoded = some(decodeS3tc(new Uint8Array(8), 'dxt1', 2, 2, short));
    assert.notEqual(decoded.buffer, short.buffer, 'bytes too few for the texels are left alone');
});

test('encoding: a block of one colour comes back as that colour, alpha as each kind keeps it, and'
    + ' blocks not named keep their bytes', ()=>{
    // 8x4: two blocks. Left pure blue at alpha 255, right a two-colour pattern.
    const width = 8;
    const height = 4;
    const texels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const at = (y * width + x) * 4;
            const right = x >= 4;
            const white = right && ((x + y) & 1) === 0;
            texels.set(right ? (white ? [255, 255, 255, 136] : [0, 0, 0, 136]) : [0, 0, 255, 255],
                at);
        }
    }
    for (const kind of /** @type {const} */ (['dxt1', 'dxt3', 'dxt5']))
    {
        const blocks = new Uint8Array(compressedBytes(kind, width, height));
        encodeS3tc(texels, kind, width, height, blocks);
        const back = /** @type {Uint8Array} */ (decodeS3tc(blocks, kind, width, height));
        assert.deepEqual([...back.subarray(0, 4)], [0, 0, 255, 255], `${kind} blue`);
        assert.deepEqual([...back.subarray(4 * 4, 4 * 4 + 3)], [255, 255, 255], `${kind} white`);
        assert.deepEqual([...back.subarray(5 * 4, 5 * 4 + 3)], [0, 0, 0], `${kind} black`);
        assert.equal(back[4 * 4 + 3], kind === 'dxt1' ? 255 : 136, `${kind} alpha`);
        // Only the left block re-encoded: the right one's bytes stay.
        const size = kind === 'dxt1' ? 8 : 16;
        blocks.fill(0xab, size, 2 * size);
        texels[0] = 255;
        encodeS3tc(texels, kind, width, height, blocks, { left: 0, top: 0, right: 1, bottom: 1 });
        assert.deepEqual([...blocks.subarray(size)], new Array(size).fill(0xab));
        assert.deepEqual([...(/** @type {Uint8Array} */ (decodeS3tc(blocks, kind, width, height)))
            .subarray(0, 3)], [255, 0, 255], 'the block named moved with its texels');
        texels[0] = 0;
    }
    // DXT1 keeps a transparent texel transparent.
    const holes = new Uint8Array(16 * 4).fill(255);
    holes[3] = 0;
    const one = new Uint8Array(8);
    encodeS3tc(holes, 'dxt1', 4, 4, one);
    const decoded = /** @type {Uint8Array} */ (decodeS3tc(one, 'dxt1', 4, 4));
    assert.equal(decoded[3], 0);
    assert.deepEqual([...decoded.subarray(4, 8)], [255, 255, 255, 255]);
});

test('encoding: DXT5 alpha keeps a ramp within half a step, every index in its place', ()=>{
    const ramp = new Uint8Array(16 * 4);
    for (let k = 0; k < 16; k++)
    {
        ramp.set([10, 20, 30, k * 17], k * 4);
    }
    const block = new Uint8Array(16);
    encodeS3tc(ramp, 'dxt5', 4, 4, block);
    const back = /** @type {Uint8Array} */ (decodeS3tc(block, 'dxt5', 4, 4));
    for (let k = 0; k < 16; k++)
    {
        assert.ok(Math.abs(back[k * 4 + 3] - k * 17) <= 19, `texel ${k}: ${back[k * 4 + 3]}`);
    }
});
