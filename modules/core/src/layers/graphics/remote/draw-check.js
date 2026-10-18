/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A diagnostic (`checkDraws`): whether the bytes a draw reads from a buffer
 * are the bytes the played side has of them.
 *
 * The recording sends a buffer's bytes as it decides they changed -- the pages
 * the engine's write watch says were written, an unlock's ranges -- and the
 * played side draws from what it was sent. This keeps, page by page, what was
 * sent of each guest page and which of its bytes were, and at each draw
 * compares what the draw reads in guest memory now, after the draw's own
 * sends, against it. A byte that differs is one the draw would take stale: a
 * write the watch did not report, a range compared once in a pause the
 * program did not keep. The guest's memory is read at the draw, as the host
 * plays it; a program that wrote a range again after the draw was recorded,
 * which Direct3D does not let it, would show here too.
 */

/** Bytes in a guest page, as a shift. */
const PAGE_SHIFT = 12;
const PAGE = 1 << PAGE_SHIFT;
/** How many of the stale draws are kept as they were found. */
const SAMPLES = 24;

/**
 * @typedef {Object} DrawCheck
 * @property {(address: number, bytes: Uint8Array) => void} sent
 *     bytes of guest memory the played side was sent (or is, with the call)
 * @property {(address: number, length: number, what: Record<string, unknown>) => void} drew
 *     a draw reads the range: compared now
 * @property {() => DrawCheckFigures} figures
 */

/**
 * @typedef {Object} DrawCheckFigures
 * @property {number} draws  ranges compared
 * @property {number} stale  of those, ranges with a byte the played side has otherwise
 * @property {number} staleBytes
 * @property {number} unknownBytes  bytes read that were never sent, not compared
 * @property {Record<string, unknown>[]} samples  the first stale ones
 */

/**
 * @param {(address: number, length: number) => Uint8Array} read  guest memory, now
 * @returns {DrawCheck}
 */
export function createDrawCheck(read){
    /** What the played side has of each page, and which of its bytes it has. @type {Map<number, { bytes: Uint8Array, known: Uint8Array }>} */
    const pages = new Map();
    const figures = { draws: 0, stale: 0, staleBytes: 0, unknownBytes: 0,
        samples: /** @type {Record<string, unknown>[]} */ ([]) };
    /** @param {number} page */
    const pageOf = page=>{
        let entry = pages.get(page);
        if (!entry)
        {
            entry = { bytes: new Uint8Array(PAGE), known: new Uint8Array(PAGE) };
            pages.set(page, entry);
        }
        return entry;
    };
    return {
        sent(address, bytes){
            for (let at = 0; at < bytes.length;)
            {
                const where = (address + at) >>> 0;
                const entry = pageOf(where >>> PAGE_SHIFT);
                const offset = where & (PAGE - 1);
                const count = Math.min(PAGE - offset, bytes.length - at);
                entry.bytes.set(bytes.subarray(at, at + count), offset);
                entry.known.fill(1, offset, offset + count);
                at += count;
            }
        },
        drew(address, length, what){
            if (length <= 0)
            {
                return;
            }
            figures.draws++;
            const now = read(address, length);
            let stale = 0;
            let first = -1;
            for (let at = 0; at < length;)
            {
                const where = (address + at) >>> 0;
                const entry = pages.get(where >>> PAGE_SHIFT);
                const offset = where & (PAGE - 1);
                const count = Math.min(PAGE - offset, length - at);
                if (!entry)
                {
                    figures.unknownBytes += count;
                    at += count;
                    continue;
                }
                for (let k = 0; k < count; k++)
                {
                    if (entry.known[offset + k] === 0)
                    {
                        figures.unknownBytes++;
                    }
                    else if (entry.bytes[offset + k] !== now[at + k])
                    {
                        stale++;
                        if (first < 0)
                        {
                            first = at + k;
                        }
                    }
                }
                at += count;
            }
            if (stale === 0)
            {
                return;
            }
            figures.stale++;
            figures.staleBytes += stale;
            if (figures.samples.length < SAMPLES)
            {
                figures.samples.push({ ...what, address, length, stale, first,
                    page: ((address + first) >>> PAGE_SHIFT).toString(16) });
            }
        },
        figures: ()=>({ ...figures, samples: [...figures.samples] }),
    };
}
