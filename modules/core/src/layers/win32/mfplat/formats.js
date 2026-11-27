/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Media Foundation's arithmetic on formats: frame rates and frame times, a
 * frame's size in bytes, and the wide multiply-divide its clocks scale by.
 * Pure functions over numbers and GUIDs; the exports that write them to guest
 * memory are in functions.js.
 */

const TICKS_PER_SECOND = 10_000_000n;

/**
 * The rates whose frame time Windows rounds to a fixed value, and recognises
 * back from any time within 30 ticks of it: 59.94, 29.97 and 23.976 are
 * NTSC's, and a frame time read off a file is rarely exact.
 */
const KNOWN_RATES = [
    { numerator: 60000, denominator: 1001, time: 166833 },
    { numerator: 30000, denominator: 1001, time: 333667 },
    { numerator: 24000, denominator: 1001, time: 417188 },
    { numerator: 60, denominator: 1, time: 166667 },
    { numerator: 30, denominator: 1, time: 333333 },
    { numerator: 50, denominator: 1, time: 200000 },
    { numerator: 25, denominator: 1, time: 400000 },
    { numerator: 24, denominator: 1, time: 416667 },
];

/** How far from a known rate's time a time still names that rate. */
const KNOWN_TOLERANCE = 30;

/** The longest frame time a rate is made from: ten seconds a frame. */
const LONGEST_FRAME = 100_000_000n;

/** @param {bigint} a @param {bigint} b @returns {bigint} */
const gcd = (a, b)=>(b === 0n ? a : gcd(b, a % b));

/**
 * MFFrameRateToAverageTimePerFrame: 100-nanosecond units a frame, a known
 * rate's own time, another's truncated; a zero numerator is no rate at all.
 *
 * @param {number} numerator @param {number} denominator @returns {bigint}
 */
export function frameRateToTime(numerator, denominator){
    const known = KNOWN_RATES.find(rate=>rate.numerator === numerator
        && rate.denominator === denominator);
    if (known)
    {
        return BigInt(known.time);
    }
    if (numerator === 0)
    {
        return 0n;
    }
    return TICKS_PER_SECOND * BigInt(denominator >>> 0) / BigInt(numerator >>> 0);
}

/**
 * MFAverageTimePerFrameToFrameRate: a known rate for a time within 30 ticks
 * of its own, otherwise ten million over the time, reduced, the time held to
 * at most ten seconds; a time of zero is a rate of 0/0.
 *
 * @param {bigint} time @returns {{ numerator: number, denominator: number }}
 */
export function timeToFrameRate(time){
    if (time === 0n)
    {
        return { numerator: 0, denominator: 0 };
    }
    const known = KNOWN_RATES.find(rate=>time >= BigInt(rate.time - KNOWN_TOLERANCE)
        && time <= BigInt(rate.time + KNOWN_TOLERANCE));
    if (known)
    {
        return { numerator: known.numerator, denominator: known.denominator };
    }
    const held = time > LONGEST_FRAME ? LONGEST_FRAME : time;
    const common = gcd(TICKS_PER_SECOND, held);
    return { numerator: Number(TICKS_PER_SECOND / common), denominator: Number(held / common) };
}

const INT64_MAX = (1n << 63n) - 1n;

/**
 * MFllMulDiv: (a * b + d) / c, the product kept whole however wide it is and
 * the quotient truncated toward zero; a zero divisor answers the largest
 * LONGLONG.
 *
 * @param {bigint} a @param {bigint} b @param {bigint} c @param {bigint} d @returns {bigint}
 */
export function mulDiv(a, b, c, d){
    if (c === 0n)
    {
        return INT64_MAX;
    }
    return BigInt.asIntN(64, (a * b + d) / c);
}

/** A video subtype whose first word is a FOURCC or a D3DFORMAT, as MFVideoFormat_* are. */
const FOURCC_TAIL = '-0000-0010-8000-00AA00389B71}';

/** @param {string} code @returns {string} */
const fourcc = code=>`{${[...code].map(c=>c.charCodeAt(0)).reverse()
    .map(byte=>byte.toString(16).padStart(2, '0')).join('').toUpperCase()}${FOURCC_TAIL}`;
/** @param {number} format @returns {string} */
const d3dFormat = format=>`{${format.toString(16).padStart(8, '0').toUpperCase()}${FOURCC_TAIL}`;

/**
 * How a frame of a subtype lies in a contiguous buffer.
 *
 * `rgb`: rows of `bits` a pixel, each padded to a DWORD (DirectShow's and
 * GDI's DIB rule). `packed`: rows of `bits` a pixel with the width rounded up
 * to `columns`. `planar`: a full-height luma plane, its width rounded up to
 * `columns` and `sample` bytes a sample, and chroma making it `chroma` times
 * as large - half again for 4:2:0 and 4:1:1, twice for IMC1/IMC3, whose
 * secondary plane keeps the luma's stride.
 *
 * @typedef {{ kind: 'rgb', bits: number } | { kind: 'packed', bits: number, columns: number }
 *     | { kind: 'planar', sample: number, columns: number, chroma: number }} Layout
 */

/** @type {Map<string, Layout>} */
const LAYOUTS = new Map([
    [d3dFormat(41), { kind: 'rgb', bits: 8 }],                 // RGB8 (D3DFMT_P8)
    [d3dFormat(24), { kind: 'rgb', bits: 16 }],                // RGB555 (X1R5G5B5)
    [d3dFormat(23), { kind: 'rgb', bits: 16 }],                // RGB565 (R5G6B5)
    [d3dFormat(20), { kind: 'rgb', bits: 24 }],                // RGB24 (R8G8B8)
    [d3dFormat(22), { kind: 'rgb', bits: 32 }],                // RGB32 (X8R8G8B8)
    [d3dFormat(21), { kind: 'rgb', bits: 32 }],                // ARGB32 (A8R8G8B8)
    [d3dFormat(32), { kind: 'rgb', bits: 32 }],                // ABGR32 (A8B8G8R8)
    [d3dFormat(35), { kind: 'rgb', bits: 32 }],                // A2R10G10B10
    [d3dFormat(31), { kind: 'rgb', bits: 32 }],                // A2B10G10R10
    [d3dFormat(113), { kind: 'rgb', bits: 64 }],               // A16B16G16R16F
    // DirectShow's RGB subtypes, which MFCalculateImageSize takes too.
    ['{E436EB7A-524F-11CE-9F53-0020AF0BA770}', { kind: 'rgb', bits: 8 }],
    ['{E436EB7C-524F-11CE-9F53-0020AF0BA770}', { kind: 'rgb', bits: 16 }],
    ['{E436EB7B-524F-11CE-9F53-0020AF0BA770}', { kind: 'rgb', bits: 16 }],
    ['{E436EB7D-524F-11CE-9F53-0020AF0BA770}', { kind: 'rgb', bits: 24 }],
    ['{E436EB7E-524F-11CE-9F53-0020AF0BA770}', { kind: 'rgb', bits: 32 }],
    [fourcc('AYUV'), { kind: 'packed', bits: 32, columns: 1 }],
    [fourcc('YUY2'), { kind: 'packed', bits: 16, columns: 2 }],
    [fourcc('UYVY'), { kind: 'packed', bits: 16, columns: 2 }],
    [fourcc('YVYU'), { kind: 'packed', bits: 16, columns: 2 }],
    [fourcc('IMC1'), { kind: 'planar', sample: 1, columns: 2, chroma: 2 }],
    [fourcc('IMC3'), { kind: 'planar', sample: 1, columns: 2, chroma: 2 }],
    [fourcc('NV12'), { kind: 'planar', sample: 1, columns: 2, chroma: 1.5 }],
    [fourcc('IMC2'), { kind: 'planar', sample: 1, columns: 2, chroma: 1.5 }],
    [fourcc('IMC4'), { kind: 'planar', sample: 1, columns: 2, chroma: 1.5 }],
    [fourcc('YV12'), { kind: 'planar', sample: 1, columns: 2, chroma: 1.5 }],
    [fourcc('I420'), { kind: 'planar', sample: 1, columns: 2, chroma: 1.5 }],
    [fourcc('IYUV'), { kind: 'planar', sample: 1, columns: 2, chroma: 1.5 }],
    [fourcc('NV11'), { kind: 'planar', sample: 1, columns: 4, chroma: 1.5 }],
    [fourcc('P010'), { kind: 'planar', sample: 2, columns: 2, chroma: 1.5 }],
    [fourcc('P016'), { kind: 'planar', sample: 2, columns: 2, chroma: 1.5 }],
]);

/** @param {number} value @param {number} step @returns {number} */
const roundUp = (value, step)=>Math.ceil(value / step) * step;

/**
 * MFCalculateImageSize: the bytes one frame of a subtype takes in a
 * contiguous buffer, or null for a subtype it does not know.
 *
 * @param {string} subtype  canonical upper-case GUID
 * @param {number} width @param {number} height
 * @returns {number | null}
 */
export function imageSize(subtype, width, height){
    const layout = LAYOUTS.get(subtype);
    if (!layout)
    {
        return null;
    }
    switch (layout.kind)
    {
        case 'rgb':
            return roundUp(Math.ceil(width * layout.bits / 8), 4) * height;
        case 'packed':
            return roundUp(width, layout.columns) * layout.bits / 8 * height;
        default:
            return Math.floor(roundUp(width, layout.columns) * layout.sample * height
                * layout.chroma);
    }
}
