/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A file kept as the pieces a writer handed its sink, readable as a byte
 * source without ever being joined into one block, and streams whose bytes
 * are computed where they are asked for: what lets a test write and read a
 * package of tens of megabytes holding each byte once.
 */

/**
 * A byte at a place in a computed stream. It changes from sector to sector as
 * well as within one, so a sector written in the wrong place does not read
 * back as the right one.
 *
 * @param {number} at @param {number} seed
 */
const patternByte = (at, seed)=>(at * 31 + (at >>> 9) * 7 + (at >>> 17) + seed) & 0xff;

/**
 * A computed stream's bytes over a range.
 *
 * @param {number} offset @param {number} length @param {number} seed
 */
export function pattern(offset, length, seed){
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index++)
    {
        out[index] = patternByte(offset + index, seed);
    }
    return out;
}

/**
 * A computed stream as a byte source, every read it is asked for recorded.
 *
 * @param {number} size @param {number} seed
 */
export function patternSource(size, seed){
    /** @type {number[]} */
    const reads = [];
    return {
        size,
        reads,
        /** @param {number} offset @param {number} length */
        read: (offset, length)=>{
            reads.push(length);
            return pattern(offset, Math.min(length, size - offset), seed);
        },
    };
}

/**
 * Whether `bytes` are the computed stream's from `offset`.
 *
 * @param {Uint8Array} bytes @param {number} offset @param {number} seed
 */
export function isPattern(bytes, offset, seed){
    for (let index = 0; index < bytes.length; index++)
    {
        if (bytes[index] !== patternByte(offset + index, seed))
        {
            return false;
        }
    }
    return true;
}

/**
 * A sink that keeps what it is given, and a source over it.
 *
 * @returns {{ sink: import('./compound-writer.js').CompoundSink,
 *     writes: { offset: number, length: number }[],
 *     source: () => import('./compound.js').ByteSource }}
 */
export function pieceFile(){
    /** @type {{ offset: number, bytes: Uint8Array }[]} */
    const pieces = [];
    /** @type {{ offset: number, length: number }[]} */
    const writes = [];
    return {
        writes,
        sink: {
            write: (offset, bytes)=>{
                writes.push({ offset, length: bytes.length });
                pieces.push({ offset, bytes });
            },
        },
        source: ()=>{
            const sorted = [...pieces].sort((left, right)=>left.offset - right.offset);
            const last = sorted[sorted.length - 1];
            return {
                size: last ? last.offset + last.bytes.length : 0,
                read: (offset, length)=>{
                    const out = new Uint8Array(length);
                    // The last piece that starts at or before the range.
                    let low = 0;
                    let high = sorted.length - 1;
                    while (low < high)
                    {
                        const middle = (low + high + 1) >> 1;
                        if (sorted[middle].offset <= offset)
                        {
                            low = middle;
                        }
                        else
                        {
                            high = middle - 1;
                        }
                    }
                    for (let index = low; index < sorted.length; index++)
                    {
                        const piece = sorted[index];
                        if (piece.offset >= offset + length)
                        {
                            break;
                        }
                        const from = Math.max(offset, piece.offset);
                        const to = Math.min(offset + length, piece.offset + piece.bytes.length);
                        if (to > from)
                        {
                            out.set(piece.bytes.subarray(from - piece.offset, to - piece.offset),
                                from - offset);
                        }
                    }
                    return out;
                },
            };
        },
    };
}
