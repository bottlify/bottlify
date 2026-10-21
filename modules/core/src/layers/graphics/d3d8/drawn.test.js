/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexRanges, reportDynamicReads } from './drawn.js';
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
        // The streams as the devices pass them, an iterator over their table:
        // read once by the scan of the indices, they reported nothing.
        const streams = new Map([[0, { buffer: vertexBuffer, offset: 0, stride }]]).values();
        reportDynamicReads(drawsFrom, streams, base, declaredCount, indices, startIndex, indexCount,
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

/**
 * A write watch over a test's memory, as the engine's (`watchWrites`): a page
 * written since a watch last looked at it is answered once to that watch.
 */
function testWatches(){
    let tick = 0;
    /** @type {Map<number, number>} */
    const writtenAt = new Map();
    return {
        /** @param {number} address @param {number} length */
        written(address, length){
            tick++;
            for (let page = address >>> 12; page <= (address + length - 1) >>> 12; page++)
            {
                writtenAt.set(page, tick);
            }
        },
        /** @param {number} address @param {number} length */
        watch(address, length){
            const first = address >>> 12;
            /** @type {number[]} */
            const seen = new Array(((address + length - 1) >>> 12) - first + 1).fill(++tick);
            return {
                /** @param {number} from @param {number} bytes */
                take(from, bytes){
                    tick++;
                    /** @type {number[]} */
                    const changed = [];
                    const low = Math.max(first, from >>> 12);
                    const high = Math.min(first + seen.length - 1, (from + bytes - 1) >>> 12);
                    for (let page = low; page <= high; page++)
                    {
                        if ((writtenAt.get(page) ?? 0) > seen[page - first])
                        {
                            changed.push(page);
                        }
                        seen[page - first] = tick;
                    }
                    return changed;
                },
            };
        },
    };
}

test('kept ranges of a static index buffer report what reading it at every draw does', ()=>{
    // The ranges kept between draws, forgotten at a write the watch reports --
    // the next draw's look may take a page another range covers -- against the
    // indices read at every draw, over random draws and writes of one buffer.
    const next = random(11);
    for (let round = 0; round < 200; round++)
    {
        const memory = new Uint8Array(0x20000);
        const watches = testWatches();
        const ranges = createIndexRanges((address, length)=>watches.watch(address, length));
        const wide = next() < 0.5;
        const size = wide ? 4 : 2;
        const indexBase = 0x2000 + Math.floor(next() * 4) * 2;
        const indexTotal = 2000 + Math.floor(next() * 12000);
        const indices = { usage: 0, base: indexBase, length: indexTotal * size,
            format: wide ? D3DFMT_INDEX.INDEX32 : D3DFMT_INDEX.INDEX16 };
        const stride = 32;
        const vertexBuffer = { usage: DYNAMIC, length: 60000 * stride };
        /** @param {number} at @param {number} value */
        const writeIndex = (at, value)=>{
            for (let byte = 0; byte < size; byte++)
            {
                memory[indexBase + at * size + byte] = (value >>> (8 * byte)) & 0xff;
            }
        };
        for (let k = 0; k < indexTotal; k++)
        {
            writeIndex(k, Math.floor(next() * 50000));
        }
        // A few ranges a frame draws again and again, and some of their own.
        const drawn = Array.from({ length: 6 }, ()=>{
            const count = 3 * (1 + Math.floor(next() * 300));
            return [Math.floor(next() * (indexTotal - count)), count];
        });
        for (let step = 0; step < 120; step++)
        {
            if (next() < 0.15)
            {
                // A write through a lock or through a pointer kept past one.
                const at = Math.floor(next() * indexTotal);
                const span = 1 + Math.floor(next() * 40);
                for (let k = at; k < Math.min(indexTotal, at + span); k++)
                {
                    writeIndex(k, Math.floor(next() * 50000));
                }
                watches.written(indexBase + at * size, span * size);
                continue;
            }
            const [startIndex, indexCount] = next() < 0.8
                ? drawn[Math.floor(next() * drawn.length)]
                : (count=>[Math.floor(next() * (indexTotal - count)), count])(
                    3 * (1 + Math.floor(next() * 300)));
            const base = Math.floor(next() * 8);
            /** @param {any} kept */
            const reported = kept=>{
                /** @type {[number, number][]} */
                const got = [];
                reportDynamicReads((buffer, from, to)=>{
                    if (buffer === vertexBuffer)
                    {
                        got.push([from, to]);
                    }
                }, [{ buffer: vertexBuffer, offset: 0, stride }], base, 60000 - base, indices,
                startIndex, indexCount,
                { read: (at, length)=>memory.subarray(at, at + length), base, ranges: kept });
                return got;
            };
            assert.deepEqual(reported(ranges), reported(null),
                `round ${round}, step ${step}: indices ${startIndex}+${indexCount}`);
        }
    }
});
