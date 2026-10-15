/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportDynamicReads } from './drawn.js';
import { D3DFMT_INDEX } from './constants.js';

const DYNAMIC = 0x200;

/** @param {number} seed */
const random = seed=>()=>{
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 0x100000000;
};

test('an indexed draw reports the vertices its indices name, never fewer than it reads', ()=>{
    // A program that appends batches to one dynamic buffer and declares the
    // rest of the buffer as each draw's range had the whole of it compared
    // at every draw -- 35 MB a frame in a shooter. Over random draws: what is
    // reported covers every vertex an index names, and never more than was
    // declared.
    const next = random(7);
    for (let round = 0; round < 300; round++)
    {
        const stride = 4 * (1 + Math.floor(next() * 12));
        const vertices = 64 + Math.floor(next() * 4000);
        const vertexBuffer = { usage: DYNAMIC, length: vertices * stride };
        const wide = next() < 0.5;
        const size = wide ? 4 : 2;
        const memory = new Uint8Array(0x40000);
        const indexBase = 0x1000 + Math.floor(next() * 3);
        const indexCount = 3 * (1 + Math.floor(next() * 200));
        const startIndex = Math.floor(next() * 50);
        const indices = { usage: next() < 0.5 ? DYNAMIC : 0, base: indexBase,
            length: (startIndex + indexCount) * size,
            format: wide ? D3DFMT_INDEX.INDEX32 : D3DFMT_INDEX.INDEX16 };
        const base = Math.floor(next() * 16);
        const low = Math.floor(next() * (vertices - base - 1));
        const span = 1 + Math.floor(next() * Math.min(300, vertices - base - low));
        const named = [];
        for (let k = 0; k < indexCount; k++)
        {
            const index = low + Math.floor(next() * span);
            named.push(index);
            const at = indexBase + (startIndex + k) * size;
            for (let byte = 0; byte < size; byte++)
            {
                memory[at + byte] = (index >>> (8 * byte)) & 0xff;
            }
        }
        /** @type {[any, number, number][]} */
        const reported = [];
        const drawsFrom = (/** @type {any} */ buffer, /** @type {number} */ from,
            /** @type {number} */ to)=>reported.push([buffer, from, to]);
        const declaredCount = vertices - base;
        reportDynamicReads(drawsFrom, [{ buffer: vertexBuffer, offset: 0, stride }], base,
            declaredCount, indices, startIndex, indexCount,
            { read: (at, length)=>memory.subarray(at, at + length), base });
        const vertexRange = reported.find(([buffer])=>buffer === vertexBuffer);
        assert.ok(vertexRange, `round ${round}: the vertices are reported`);
        const [, from, to] = /** @type {[any, number, number]} */ (vertexRange);
        for (const index of named)
        {
            const at = (base + index) * stride;
            assert.ok(at >= from && at + stride <= to,
                `round ${round}: vertex ${base + index} in [${from}, ${to})`);
        }
        assert.ok(to - from <= declaredCount * stride, 'never more than declared');
        if ((indices.usage & DYNAMIC) !== 0)
        {
            assert.deepEqual(reported.find(([buffer])=>buffer === indices)?.slice(1),
                [startIndex * size, (startIndex + indexCount) * size]);
        }
    }
});

test('a declared range no larger than its indices is compared as it is', ()=>{
    // Reading the indices costs about what comparing so few vertices does.
    const memory = new Uint8Array(0x100);
    const vertexBuffer = { usage: DYNAMIC, length: 0x1000 };
    const indices = { usage: 0, base: 0x10, length: 0x60, format: D3DFMT_INDEX.INDEX16 };
    /** @type {number[][]} */
    const reported = [];
    reportDynamicReads((_, from, to)=>reported.push([from, to]),
        [{ buffer: vertexBuffer, offset: 0, stride: 4 }], 2, 6, indices, 0, 48,
        { read: (at, length)=>memory.subarray(at, at + length), base: 2 });
    assert.deepEqual(reported, [[8, 32]]);
});
