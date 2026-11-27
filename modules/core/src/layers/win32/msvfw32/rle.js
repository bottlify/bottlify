/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run-length encodings of a DIB, BI_RLE8 and BI_RLE4, as the BITMAPINFOHEADER
 * documentation lays them out: a pair is a run (a count and the index it
 * repeats) or an escape - 0,0 ends a line, 0,1 ends the picture, 0,2,dx,dy moves
 * on, 0,n with n of three or more is n indices given one by one, padded to a
 * word. What msrle32, the system's run-length codec, reads and writes.
 */

/**
 * Reads a run-length picture into one index a pixel, bottom row first as the
 * DIB keeps it. A pixel the picture never reaches keeps what `into` had: a
 * frame that moves on (0,2) or ends early leaves the previous frame there.
 *
 * @param {Uint8Array} data
 * @param {number} width @param {number} height
 * @param {4 | 8} depth
 * @param {Uint8Array} [into]  width * height indices to draw over
 * @returns {Uint8Array}
 */
export function decodeRle(data, width, height, depth, into = new Uint8Array(width * height)){
    let x = 0;
    let y = 0;
    let at = 0;
    /** @param {number} index */
    const put = index=>{
        if (x < width && y < height)
        {
            into[y * width + x] = index;
        }
        x++;
    };
    while (at + 1 < data.length && y < height)
    {
        const count = data[at];
        const value = data[at + 1];
        at += 2;
        if (count > 0)
        {
            for (let i = 0; i < count; i++)
            {
                put(depth === 8 ? value : (i & 1) === 0 ? value >> 4 : value & 15);
            }
            continue;
        }
        if (value === 0)
        {
            x = 0;
            y++;
        }
        else if (value === 1)
        {
            break;
        }
        else if (value === 2)
        {
            x += data[at] ?? 0;
            y += data[at + 1] ?? 0;
            at += 2;
        }
        else
        {
            const bytes = depth === 8 ? value : (value + 1) >> 1;
            for (let i = 0; i < value; i++)
            {
                const byte = data[at + (depth === 8 ? i : i >> 1)] ?? 0;
                put(depth === 8 ? byte : (i & 1) === 0 ? byte >> 4 : byte & 15);
            }
            at += bytes + (bytes & 1);
        }
    }
    return into;
}

/** Literals shorter than this go as runs of one: an absolute group holds three or more. */
const LEAST_ABSOLUTE = 3;

/**
 * Writes one row of 8-bit indices as BI_RLE8 pairs: a repeat of two or more is
 * a run, a stretch of three or more pixels that do not repeat is an absolute
 * group, and anything shorter goes as runs of one. A row ends with 0,0.
 *
 * @param {Uint8Array} row
 * @param {number[]} out
 */
function encodeRow(row, out){
    let at = 0;
    while (at < row.length)
    {
        let run = 1;
        while (at + run < row.length && row[at + run] === row[at] && run < 255)
        {
            run++;
        }
        if (run >= 2)
        {
            out.push(run, row[at]);
            at += run;
            continue;
        }
        // A literal stretch: up to the next pair of equal pixels.
        let end = at + 1;
        while (end < row.length && end - at < 255
            && !(end + 1 < row.length && row[end] === row[end + 1]))
        {
            end++;
        }
        const length = end - at;
        if (length < LEAST_ABSOLUTE)
        {
            for (let i = at; i < end; i++)
            {
                out.push(1, row[i]);
            }
        }
        else
        {
            out.push(0, length, ...row.subarray(at, end));
            if (length & 1)
            {
                out.push(0);
            }
        }
        at = end;
    }
    out.push(0, 0);
}

/**
 * Encodes an 8-bit DIB's indices (bottom row first, one byte a pixel, rows
 * `stride` apart) as BI_RLE8. A frame that is not a key frame leaves a row the
 * previous frame had unchanged to it: the row is its end-of-line alone.
 *
 * @param {Uint8Array} bits @param {number} width @param {number} height
 * @param {number} stride
 * @param {Uint8Array | null} previous  the frame before, laid out as `bits`, for a delta frame
 * @returns {Uint8Array}
 */
export function encodeRle8(bits, width, height, stride, previous){
    /** @type {number[]} */
    const out = [];
    for (let y = 0; y < height; y++)
    {
        const row = bits.subarray(y * stride, y * stride + width);
        if (previous)
        {
            const before = previous.subarray(y * stride, y * stride + width);
            if (row.every((value, i)=>value === before[i]))
            {
                out.push(0, 0);
                continue;
            }
        }
        encodeRow(row, out);
    }
    // Every row ends its line, the last one too, and the picture ends after it.
    out.push(0, 1);
    return Uint8Array.from(out);
}
