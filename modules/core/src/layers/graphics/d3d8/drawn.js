/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { D3DFMT_INDEX } from './constants.js';

/** D3DUSAGE_DYNAMIC: a buffer the program may write while the GPU reads it. */
const DYNAMIC = 0x200;

/**
 * Tells `drawsFrom` which bytes of each dynamic buffer a draw reads: a
 * dynamic buffer's memory stays the buffer's after its unlock, as a driver
 * keeps it, and a program may write it there and draw, so a device that
 * draws elsewhere has to send those bytes with the draw. Only dynamic
 * buffers: any other is written only between a lock and its unlock, which
 * send what they let the program write.
 *
 * The vertices are the draw's own (`first`, `count`); a stream read once per
 * instance is read whole from its offset, since its stride does not say how
 * far an instance count reaches.
 *
 * @param {(buffer: any, from: number, to: number) => void} drawsFrom
 * @param {Iterable<{ buffer: any, offset?: number, stride: number, whole?: boolean }>} streams
 * @param {number} first  the first vertex read @param {number} count  how many
 * An indexed draw reads only the vertices its indices name, and a program
 * that appends batches to one buffer often declares the rest of the buffer
 * as the draw's range: with `read` the indices are read and the range is
 * the lowest to the highest they name, when reading them costs less than
 * comparing the declared range would.
 *
 * @param {any} [indices]  the index buffer of an indexed draw
 * @param {number} [startIndex] @param {number} [indexCount]
 * @param {{ read: (address: number, length: number) => Uint8Array, base: number,
 *     ranges?: IndexRanges | null }} [indexed]
 *        guest memory as a view, the draw's base vertex index, and the vertices
 *        ranges of a static index buffer named when last read (`createIndexRanges`)
 */
export function reportDynamicReads(drawsFrom, streams, first, count, indices, startIndex = 0,
    indexCount = 0, indexed = undefined)
{
    // The streams may come as an iterator, which the range's scan would leave
    // empty for the loop after it; an array is read as it is.
    const all = Array.isArray(streams) ? streams : [...streams];
    const named = indexed && indices ? namedRange(all, count, indices, startIndex, indexCount,
        indexed) : null;
    if (named)
    {
        first = named.first;
        count = named.count;
    }
    for (const stream of all)
    {
        const buffer = stream?.buffer;
        if (!buffer || (buffer.usage & DYNAMIC) === 0 || !(stream.stride > 0))
        {
            continue;
        }
        const offset = stream.offset ?? 0;
        const from = stream.whole ? offset : offset + first * stream.stride;
        const to = stream.whole ? buffer.length : from + count * stream.stride;
        reportClamped(drawsFrom, buffer, from, to);
    }
    if (indices && (indices.usage & DYNAMIC) !== 0)
    {
        const size = indices.format === D3DFMT_INDEX.INDEX32 ? 4 : 2;
        reportClamped(drawsFrom, indices, startIndex * size, (startIndex + indexCount) * size);
    }
}

/** @param {(buffer: any, from: number, to: number) => void} drawsFrom @param {any} buffer @param {number} from @param {number} to */
const reportClamped = (drawsFrom, buffer, from, to)=>{
    const start = Math.max(0, from);
    const end = Math.min(buffer.length, to);
    if (end > start)
    {
        drawsFrom(buffer, start, end);
    }
};

/** Index bytes read for each byte of vertices the scan would spare comparing, at most. */
const SCAN_RATIO = 4;

/**
 * The vertices an indexed draw's indices name, or null when scanning them
 * would cost as much as comparing the declared range.
 *
 * @param {Iterable<{ buffer: any, stride: number, whole?: boolean }>} streams
 * @param {number} count @param {any} indices @param {number} startIndex @param {number} indexCount
 * @param {{ read: (address: number, length: number) => Uint8Array, base: number,
 *     ranges?: IndexRanges | null }} indexed
 * @returns {{ first: number, count: number } | null}
 */
function namedRange(streams, count, indices, startIndex, indexCount, indexed){
    const size = indices.format === D3DFMT_INDEX.INDEX32 ? 4 : 2;
    let declared = 0;
    for (const stream of streams)
    {
        if (stream?.buffer && (stream.buffer.usage & DYNAMIC) !== 0 && !stream.whole)
        {
            declared += count * stream.stride;
        }
    }
    const bytes = indexCount * size;
    const at = (indices.base ?? 0) + startIndex * size;
    if (declared < bytes * SCAN_RATIO || indexCount === 0 || typeof indices.base !== 'number'
        || startIndex * size + bytes > indices.length)
    {
        return null;
    }
    const ranges = (indices.usage & DYNAMIC) === 0 ? indexed.ranges ?? null : null;
    const kept = ranges === null ? null : ranges.named(indices, at, bytes);
    if (kept !== null)
    {
        return { first: indexed.base + kept.low, count: kept.high - kept.low + 1 };
    }
    const view = indexed.read(at, bytes);
    if (view.length < bytes)
    {
        return null;
    }
    const words = size === 2
        ? ((view.byteOffset & 1) === 0 ? new Uint16Array(view.buffer, view.byteOffset, indexCount)
            : Uint16Array.from({ length: indexCount }, (_, k)=>view[k * 2] | view[k * 2 + 1] << 8))
        : ((view.byteOffset & 3) === 0 ? new Uint32Array(view.buffer, view.byteOffset, indexCount)
            : Uint32Array.from({ length: indexCount }, (_, k)=>(view[k * 4] | view[k * 4 + 1] << 8
                | view[k * 4 + 2] << 16 | view[k * 4 + 3] << 24) >>> 0));
    let low = words[0];
    let high = words[0];
    for (let k = 1; k < words.length; k++)
    {
        const index = words[k];
        if (index < low)
        {
            low = index;
        }
        else if (index > high)
        {
            high = index;
        }
    }
    ranges?.keep(indices, at, bytes, low, high);
    return { first: indexed.base + low, count: high - low + 1 };
}

/**
 * The lowest and highest index each range of a static index buffer names, as
 * last read, kept while no page of the range is written (the engine's write
 * watch, `watchWrites`): a static buffer's indices are the same frame after
 * frame, and an indexed draw from a dynamic vertex buffer read them every
 * time to send only the vertices they name -- a skinned model's surfaces,
 * drawn out of a large buffer of skinned vertices, thousands of times a
 * frame. Every write reaches the watch, the program's through a lock or a
 * pointer kept past one and the host's alike; a page found written
 * forgets every range of the buffer, since another range's look may have
 * taken that page's write first. Nothing is kept where the engine has no
 * watch, nor for a dynamic buffer, which is written every frame.
 *
 * @typedef {Object} IndexRanges
 * @property {(indices: any, at: number, bytes: number) => { low: number, high: number } | null}
 *     named  what the indices at `at` named when last read, if none of their
 *     pages was written since; looked at from now either way, so a read of
 *     them after a miss is what the next look compares against
 * @property {(indices: any, at: number, bytes: number, low: number, high: number) => void} keep
 *     what a read after `named` found
 *
 * @param {((address: number, length: number) =>
 *     ({ take: (address: number, length: number) => number[] } | null)) | undefined} watchWrites
 * @returns {IndexRanges | null}
 */
export function createIndexRanges(watchWrites){
    if (typeof watchWrites !== 'function')
    {
        return null;
    }
    /**
     * Each buffer's watch, over the storage it had when watched, and its ranges
     * by their first index's address.
     *
     * @type {WeakMap<object, { base: number, watch: { take: (address: number,
     *     length: number) => number[] } | null, ranges: Map<number,
     *     { bytes: number, low: number, high: number }> }>}
     */
    const buffers = new WeakMap();
    return {
        named(indices, at, bytes){
            let kept = buffers.get(indices);
            if (kept === undefined || kept.base !== indices.base)
            {
                // The watch looks at every page as it begins: the read after
                // this miss is what it compares against.
                kept = { base: indices.base, watch: watchWrites(indices.base, indices.length),
                    ranges: new Map() };
                buffers.set(indices, kept);
                return null;
            }
            if (kept.watch === null)
            {
                return null;
            }
            if (kept.watch.take(at, bytes).length > 0)
            {
                kept.ranges.clear();
                return null;
            }
            const range = kept.ranges.get(at);
            return range !== undefined && range.bytes === bytes ? range : null;
        },
        keep(indices, at, bytes, low, high){
            const kept = buffers.get(indices);
            if (kept !== undefined && kept.watch !== null && kept.base === indices.base)
            {
                kept.ranges.set(at, { bytes, low, high });
            }
        },
    };
}
