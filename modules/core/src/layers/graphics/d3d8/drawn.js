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
 * @param {{ read: (address: number, length: number) => Uint8Array, base: number }} [indexed]
 *        guest memory as a view, and the draw's base vertex index
 */
export function reportDynamicReads(drawsFrom, streams, first, count, indices, startIndex = 0,
    indexCount = 0, indexed = undefined)
{
    // The streams may come as an iterator, which the range's scan would leave
    // empty for the loop after it.
    const all = [...streams];
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
 * @param {{ read: (address: number, length: number) => Uint8Array, base: number }} indexed
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
    return { first: indexed.base + low, count: high - low + 1 };
}
