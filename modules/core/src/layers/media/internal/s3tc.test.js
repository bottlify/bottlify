/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * S3TC/DXTn blocks: every expectation is a byte, so a change to the
 * arithmetic is a changed picture that these tests exist to notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressedBytes, decodeAlphaBlock, decodeS3tc, encodeAlphaBlock, encodeS3tc }
    from './s3tc.js';

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
    // The block on its own, as BC4 and BC5 use it, is DXT5's alpha half.
    assert.deepEqual([...decodeAlphaBlock(block, 0)], [...back].filter((_, i)=>i % 4 === 3));
    const alone = new Uint8Array(8);
    encodeAlphaBlock(ramp.filter((_, i)=>i % 4 === 3), alone, 0);
    assert.deepEqual([...alone], [...block.subarray(0, 8)]);
    assert.deepEqual([...decodeAlphaBlock(new Uint8Array([9, 9, 0, 0, 0, 0, 0, 0]), 0)],
        new Array(16).fill(9), 'one value is its own end');
});

/**
 * One texel of an S3TC image as the specification writes it out: the
 * endpoints normalised (a field over its maximum), each blended entry the
 * weighted sum of those, the result the nearest byte. Written per texel and
 * reading its bits one by one, so it shares nothing with the decoder but the
 * arithmetic the specification states.
 *
 * @param {Uint8Array} bytes @param {import('./s3tc.js').S3tcKind} kind
 * @param {number} width @param {number} x @param {number} y
 * @returns {number[]} r, g, b, a
 */
function specTexel(bytes, kind, width, x, y){
    const size = kind === 'dxt1' ? 8 : 16;
    const block = (Math.floor(y / 4) * Math.ceil(width / 4) + Math.floor(x / 4)) * size;
    const k = (y & 3) * 4 + (x & 3);
    /** @param {number} at @param {number} first @param {number} count */
    const bits = (at, first, count)=>{
        let value = 0;
        for (let i = count - 1; i >= 0; i--)
        {
            const bit = first + i;
            value = value * 2 + ((bytes[at + (bit >> 3)] >> (bit & 7)) & 1);
        }
        return value;
    };
    const colourAt = kind === 'dxt1' ? block : block + 8;
    const c0 = bits(colourAt, 0, 16);
    const c1 = bits(colourAt, 16, 16);
    const index = bits(colourAt, 32 + k * 2, 2);
    const four = kind !== 'dxt1' || c0 > c1;
    /** [shift, max] of red, green, blue. */
    const fields = [[11, 31], [5, 63], [0, 31]];
    // The weights of colour0 and colour1 in each index, and their sum.
    const weights = four ? [[1, 0, 1], [0, 1, 1], [2, 1, 3], [1, 2, 3]]
        : [[1, 0, 1], [0, 1, 1], [1, 1, 2], null];
    const weight = weights[index];
    if (weight === null)
    {
        return [0, 0, 0, 0];
    }
    const rgb = fields.map(([shift, max])=>Math.round(
        (weight[0] * ((c0 >> shift) & max) + weight[1] * ((c1 >> shift) & max)) * 255
        / (weight[2] * max)));
    if (kind === 'dxt1')
    {
        return [...rgb, 255];
    }
    if (kind === 'dxt3')
    {
        return [...rgb, Math.round(bits(block, k * 4, 4) * 255 / 15)];
    }
    const a0 = bytes[block];
    const a1 = bytes[block + 1];
    const i = bits(block, 16 + k * 3, 3);
    const steps = a0 > a1 ? 7 : 5;
    let alpha = i === 0 ? a0 : a1;
    if (i >= 2)
    {
        alpha = steps === 5 && i >= 6 ? (i === 6 ? 0 : 255)
            : Math.round(((steps + 1 - i) * a0 + (i - 1) * a1) / steps);
    }
    return [...rgb, alpha];
}

test('every texel of seeded images is the specification\'s byte, in every kind and shape', ()=>{
    let seed = 0x5eed;
    const next = ()=>(seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    for (const kind of /** @type {const} */ (['dxt1', 'dxt3', 'dxt5']))
    {
        for (const [width, height] of [[1, 1], [3, 5], [4, 4], [13, 7], [64, 64]])
        {
            const bytes = Uint8Array.from({ length: compressedBytes(kind, width, height) }, next);
            const texels = some(decodeS3tc(bytes, kind, width, height));
            for (let y = 0; y < height; y++)
            {
                for (let x = 0; x < width; x++)
                {
                    const at = (y * width + x) * 4;
                    assert.deepEqual([...texels.subarray(at, at + 4)],
                        specTexel(bytes, kind, width, x, y),
                        `${kind} ${width}x${height} (${x}, ${y})`);
                }
            }
        }
    }
});

test('an endpoint is its field over the maximum, not the field\'s bits repeated', ()=>{
    // Red 3 of 31 is 24.68, so 25, where bit replication (3 << 3 | 3 >> 2)
    // answers 24; green 1 of 63 is 4.05, so 4.
    const block = new Uint8Array(8);
    new DataView(block.buffer).setUint16(0, 3 << 11 | 1 << 5, true);
    assert.deepEqual([...some(decodeS3tc(block, 'dxt1', 4, 4)).subarray(0, 4)], [25, 4, 0, 255]);
});

test('encoding: every texel is the nearest of the colours its block decodes to', ()=>{
    // Whatever endpoints the fit chose, an index the decoder reads as a worse
    // colour than another of the same block is a picture lost to the encoder.
    let seed = 99;
    const next = ()=>(seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    for (const kind of /** @type {const} */ (['dxt1', 'dxt3', 'dxt5']))
    {
        for (let n = 0; n < 50; n++)
        {
            const texels = Uint8Array.from({ length: 16 * 4 }, next);
            const blocks = new Uint8Array(compressedBytes(kind, 4, 4));
            encodeS3tc(texels, kind, 4, 4, blocks);
            const back = some(decodeS3tc(blocks, kind, 4, 4));
            // Every colour the block can decode to, read back through each index.
            const colourAt = kind === 'dxt1' ? 0 : 8;
            const options = [0, 1, 2, 3].map(index=>{
                const probe = blocks.slice();
                new DataView(probe.buffer).setUint32(colourAt + 4, index * 0x55555555 >>> 0, true);
                return [...some(decodeS3tc(probe, kind, 4, 4)).subarray(0, 4)];
            }).filter(option=>option[3] !== 0 || kind !== 'dxt1');
            for (let k = 0; k < 16; k++)
            {
                const t = [...texels.subarray(k * 4, k * 4 + 3)];
                /** @param {number[]} c */
                const error = c=>c.slice(0, 3).reduce((s, v, i)=>s + (v - t[i]) ** 2, 0);
                if (kind === 'dxt1' && texels[k * 4 + 3] < 128)
                {
                    assert.equal(back[k * 4 + 3], 0, `${kind} #${n} texel ${k} stays a hole`);
                    continue;
                }
                assert.equal(error([...back.subarray(k * 4, k * 4 + 3)]),
                    Math.min(...options.map(error)), `${kind} #${n} texel ${k}`);
            }
        }
    }
});
