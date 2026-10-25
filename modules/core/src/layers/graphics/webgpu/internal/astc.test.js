/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dxt1ToAstc, dxt1Transcodes } from './astc.js';
import { decodeS3tc } from './s3tc.js';

/**
 * The texels of one ASTC 4x4 block, as Khronos' specification decodes it
 * (KHR_texture_compression_astc_ldr, C.2), for the blocks the transcoder
 * writes: one plane, one partition, endpoint mode 8, a 4x4 grid, weights in
 * bits or trits -- anything else throws, so a block of another shape cannot
 * pass by being misread.
 *
 * @param {Uint8Array} block  sixteen bytes
 * @returns {Uint8Array} sixteen RGBA texels, each channel the top byte of
 *     the 16-bit interpolation
 */
const decodeBlock = block=>{
    const bit = (/** @type {number} */ at)=>(block[at >> 3] >> (at & 7)) & 1;
    const bits = (/** @type {number} */ at, /** @type {number} */ count)=>{
        let value = 0;
        for (let index = 0; index < count; index++)
        {
            value |= bit(at + index) << index;
        }
        return value;
    };
    const mode = bits(0, 11);
    assert.notEqual(mode & 3, 0, 'a row of table C.2.8 with R2 R1 in bits 1:0');
    assert.equal((mode >> 2) & 3, 0, 'the first row: width B+4, height A+2');
    const width = ((mode >> 7) & 3) + 4;
    const height = ((mode >> 5) & 3) + 2;
    assert.deepEqual([width, height], [4, 4], 'a 4x4 grid');
    assert.equal((mode >> 10) & 1, 0, 'one plane');
    const high = (mode >> 9) & 1;
    const range = (((mode >> 4) & 1)) | ((mode & 1) << 1) | (((mode >> 1) & 1) << 2);
    assert.equal(bits(11, 2), 0, 'one partition');
    assert.equal(bits(13, 4), 8, 'endpoint mode 8, RGB direct');
    /** Weights: [trits, bits] by R for H 0 (table C.2.7). */
    const shapes = { 2: [0, 1], 3: [1, 0], 4: [0, 2], 7: [0, 3] };
    assert.equal(high, 0);
    const [trits, plain] = /** @type {number[]} */ (shapes[/** @type {keyof typeof shapes} */ (range)]);
    // The weights' stream: bit n at block bit 127 - n.
    const stream = (/** @type {number} */ at)=>bit(127 - at);
    const streamBits = (/** @type {number} */ at, /** @type {number} */ count)=>{
        let value = 0;
        for (let index = 0; index < count; index++)
        {
            value |= stream(at + index) << index;
        }
        return value;
    };
    /** @type {number[]} */
    const weights = [];
    if (trits === 0)
    {
        for (let index = 0; index < 16; index++)
        {
            const value = streamBits(index * plain, plain);
            // Bit replication to 0..63 (C.2.17), then past 32 one more.
            let unquantized = 0;
            for (let shift = 6 - plain; shift > -plain; shift -= plain)
            {
                unquantized |= shift >= 0 ? value << shift : value >> -shift;
            }
            weights.push(unquantized > 32 ? unquantized + 1 : unquantized);
        }
    }
    else
    {
        assert.equal(plain, 0, 'trits alone: weights in 0..2');
        const total = Math.ceil(16 * 8 / 5);
        for (let group = 0; group * 5 < 16; group++)
        {
            let packed = 0;
            for (let index = 0; index < 8; index++)
            {
                const at = group * 8 + index;
                packed |= (at < total ? stream(at) : 0) << index;
            }
            const t = (/** @type {number} */ at, /** @type {number} */ count = 1)=>
                (packed >> at) & ((1 << count) - 1);
            let c;
            let t3;
            let t4;
            if (t(2, 3) === 7)
            {
                c = (t(5, 3) << 2) | t(0, 2);
                t4 = 2;
                t3 = 2;
            }
            else
            {
                c = t(0, 5);
                if (t(5, 2) === 3)
                {
                    t4 = 2;
                    t3 = t(7);
                }
                else
                {
                    t4 = t(7);
                    t3 = t(5, 2);
                }
            }
            const cb = (/** @type {number} */ at)=>(c >> at) & 1;
            let t0;
            let t1;
            let t2;
            if ((c & 3) === 3)
            {
                t2 = 2;
                t1 = cb(4);
                t0 = (cb(3) << 1) | (cb(2) & (cb(3) ^ 1));
            }
            else if (((c >> 2) & 3) === 3)
            {
                t2 = 2;
                t1 = 2;
                t0 = c & 3;
            }
            else
            {
                t2 = cb(4);
                t1 = (c >> 2) & 3;
                t0 = (cb(1) << 1) | (cb(0) & (cb(1) ^ 1));
            }
            for (const value of [t0, t1, t2, t3, t4])
            {
                if (weights.length < 16)
                {
                    // Table C.2.25, then past 32 one more.
                    weights.push([0, 32, 64][value]);
                }
            }
        }
    }
    // Eight-bit endpoints from bit 17 up: the range the 79 or 85 bits left hold.
    const values = Array.from({ length: 6 }, (_, index)=>bits(17 + index * 8, 8));
    const s0 = values[0] + values[2] + values[4];
    const s1 = values[1] + values[3] + values[5];
    assert.ok(s1 >= s0, 'no blue contraction: the transcoder orders its endpoints');
    const e0 = [values[0], values[2], values[4], 255];
    const e1 = [values[1], values[3], values[5], 255];
    const texels = new Uint8Array(64);
    for (let texel = 0; texel < 16; texel++)
    {
        const weight = weights[texel];
        for (let channel = 0; channel < 4; channel++)
        {
            const c0 = (e0[channel] << 8) | e0[channel];
            const c1 = (e1[channel] << 8) | e1[channel];
            const c = Math.floor((c0 * (64 - weight) + c1 * weight + 32) / 64);
            texels[texel * 4 + channel] = c >> 8;
        }
    }
    return texels;
};

/** @param {() => number} next @returns {Uint8Array} a DXT1 block */
const dxt1Block = next=>{
    const block = new Uint8Array(8);
    for (let index = 0; index < 8; index++)
    {
        block[index] = next() & 0xff;
    }
    return block;
};

/** @param {number} seed */
const random = seed=>()=>{
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 16;
};

test('a four-stop DXT1 block decodes from ASTC within two steps of its own decode', ()=>{
    const next = random(1);
    let worst = 0;
    for (let round = 0; round < 4000; round++)
    {
        const block = dxt1Block(next);
        const view = new DataView(block.buffer);
        const first = view.getUint16(0, true);
        const second = view.getUint16(2, true);
        if (first === second)
        {
            continue;
        }
        if (first < second)
        {
            view.setUint16(0, second, true);
            view.setUint16(2, first, true);
        }
        const astc = /** @type {Uint8Array} */ (dxt1ToAstc(block, 4, 4));
        assert.equal(astc.length, 16);
        const expected = /** @type {Uint8Array} */ (decodeS3tc(block, 'dxt1', 4, 4));
        const got = decodeBlock(astc);
        for (let at = 0; at < 64; at++)
        {
            worst = Math.max(worst, Math.abs(got[at] - expected[at]));
        }
    }
    assert.ok(worst <= 2, `worst channel difference ${worst}`);
});

test('a three-stop DXT1 block without its fourth colour decodes from ASTC within a step', ()=>{
    const next = random(2);
    let worst = 0;
    let made = 0;
    for (let round = 0; round < 4000; round++)
    {
        const block = dxt1Block(next);
        const view = new DataView(block.buffer);
        const first = view.getUint16(0, true);
        const second = view.getUint16(2, true);
        if (first > second)
        {
            view.setUint16(0, second, true);
            view.setUint16(2, first, true);
        }
        // Index 3 is the black or transparent fourth: taken out.
        let indices = view.getUint32(4, true);
        for (let texel = 0; texel < 16; texel++)
        {
            if (((indices >>> (texel * 2)) & 3) === 3)
            {
                indices = (indices & ~(3 << (texel * 2))) | ((round % 3) << (texel * 2));
            }
        }
        view.setUint32(4, indices >>> 0, true);
        const astc = /** @type {Uint8Array} */ (dxt1ToAstc(block, 4, 4));
        const expected = /** @type {Uint8Array} */ (decodeS3tc(block, 'dxt1', 4, 4));
        const got = decodeBlock(astc);
        for (let at = 0; at < 64; at++)
        {
            worst = Math.max(worst, Math.abs(got[at] - expected[at]));
        }
        made++;
    }
    assert.equal(made, 4000);
    assert.ok(worst <= 1, `worst channel difference ${worst}`);
});

test('a DXT1 image with a texel of the fourth colour of a three-stop block is not transcoded',
    ()=>{
        const block = new Uint8Array(8);
        const view = new DataView(block.buffer);
        view.setUint16(0, 0x0010, true);
        view.setUint16(2, 0x8000, true);
        view.setUint32(4, 0b11 << 10, true);
        assert.equal(dxt1ToAstc(block, 4, 4), null);
        view.setUint16(0, 0x8000, true);
        view.setUint16(2, 0x0010, true);
        assert.ok(dxt1ToAstc(block, 4, 4), 'the same index of a four-stop block is a colour');
    });

test('an image of many blocks keeps their order, a partial block whole', ()=>{
    const next = random(3);
    const width = 10;
    const height = 6;
    const blocks = 3 * 2;
    const bytes = new Uint8Array(blocks * 8);
    for (let block = 0; block < blocks; block++)
    {
        const one = dxt1Block(next);
        const view = new DataView(one.buffer);
        view.setUint16(0, view.getUint16(0, true) | 0x8000, true);
        view.setUint16(2, view.getUint16(2, true) & 0x7fff, true);
        bytes.set(one, block * 8);
    }
    const astc = /** @type {Uint8Array} */ (dxt1ToAstc(bytes, width, height));
    assert.equal(astc.length, blocks * 16);
    const expected = /** @type {Uint8Array} */ (decodeS3tc(bytes, 'dxt1', width, height));
    for (let block = 0; block < blocks; block++)
    {
        const got = decodeBlock(astc.subarray(block * 16, block * 16 + 16));
        const bx = block % 3;
        const by = Math.floor(block / 3);
        for (let texel = 0; texel < 16; texel++)
        {
            const x = bx * 4 + (texel & 3);
            const y = by * 4 + (texel >> 2);
            if (x >= width || y >= height)
            {
                continue;
            }
            for (let channel = 0; channel < 4; channel++)
            {
                assert.ok(Math.abs(got[texel * 4 + channel]
                    - expected[(y * width + x) * 4 + channel]) <= 2);
            }
        }
    }
    assert.equal(dxt1ToAstc(bytes.subarray(0, 40), width, height), null, 'too few bytes');
});

test('whether an image transcodes is read without transcoding it, and agrees', ()=>{
    const next = random(4);
    for (let round = 0; round < 2000; round++)
    {
        const bytes = new Uint8Array(4 * 8);
        for (let index = 0; index < bytes.length; index++)
        {
            bytes[index] = next() & 0xff;
        }
        assert.equal(dxt1Transcodes(bytes, 8, 8), dxt1ToAstc(bytes, 8, 8) !== null);
    }
    assert.equal(dxt1Transcodes(new Uint8Array(8), 8, 8), false, 'too few bytes');
});
