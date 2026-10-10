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
 * @param {any} [indices]  the index buffer of an indexed draw
 * @param {number} [startIndex] @param {number} [indexCount]
 */
export function reportDynamicReads(drawsFrom, streams, first, count, indices, startIndex = 0,
    indexCount = 0)
{
    for (const stream of streams)
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
