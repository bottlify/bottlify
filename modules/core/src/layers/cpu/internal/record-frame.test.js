/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { frame, inflateRaw, plain, unframe, unframeLater } from './record-frame.js';

/** Bytes of a kind deflate meets in translated code: repeats near and far, and noise. */
const sample = (/** @type {number} */ seed, /** @type {number} */ length)=>{
    let state = seed >>> 0 || 1;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    const out = new Uint8Array(length);
    for (let i = 0; i < length;)
    {
        const kind = next() % 4;
        if (kind === 0 && i > 0)
        {
            const distance = 1 + next() % Math.min(i, 40000);
            const run = 3 + next() % 300;
            for (let k = 0; k < run && i < length; k++, i++)
            {
                out[i] = out[i - distance];
            }
        }
        else
        {
            out[i++] = kind === 1 ? next() & 0xff : next() % 16;
        }
    }
    return out;
};

test('raw deflate reads back what zlib wrote, at every level and every kind of block', ()=>{
    // Level 0 stored blocks, small inputs fixed codes, larger ones dynamic codes.
    for (const length of [0, 1, 100, 5000, 70000, 300000])
    {
        for (const level of [0, 1, 6, 9])
        {
            for (const seed of [1, 7, 99])
            {
                const raw = sample(seed + length, length);
                const packed = deflateRawSync(raw, { level });
                assert.deepEqual(inflateRaw(packed), raw, `${length} bytes, level ${level}`);
            }
        }
    }
});

test('a framed record reads back whole; a small one is kept as it is, a bad one is no record',
    async()=>{
        const big = sample(3, 200000);
        const framed = await frame(big);
        assert.equal(framed[0], 1, 'compressed');
        assert.ok(framed.length < big.length / 2, `${framed.length} of ${big.length}`);
        assert.deepEqual(unframe(framed), big);
        assert.deepEqual(await unframeLater(framed), big, 'the platform\'s inflate the same');
        assert.equal(await unframeLater(framed.subarray(0, 9)), null, 'cut short, waited for');
        const small = sample(4, 100);
        assert.deepEqual([...await frame(small)], [0, ...small]);
        assert.deepEqual(unframe(plain(small)), small);
        assert.equal(unframe(new Uint8Array([7, 1, 2])), null, 'a frame of no known kind');
        assert.equal(unframe(framed.subarray(0, framed.length >> 1)), null, 'cut short');
        assert.equal(unframe(new Uint8Array(0)), null);
    });
