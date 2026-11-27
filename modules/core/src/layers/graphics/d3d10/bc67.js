/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * BC6H and BC7 blocks decoded on the processor, for a GPU that samples no BC
 * format: BC7 into eight-bit RGBA, BC6H into half-float RGBA (alpha 1.0).
 *
 * Derived from Microsoft's specification: the D3D11.3 functional
 * specification (19.5.13 BC6H, 19.5.14 BC7) and the "BC6H Format" and "BC7
 * Format" pages of the Direct3D 11 documentation - the mode tables, the
 * header bit fields of BC6H's fourteen modes (bc6h-headers-med.png), the
 * partition and fix-up tables (D3D11_3_BC7_2Subsets.png, D3D11_3_BC7_3Subsets.png;
 * BC6H's 32 shapes are BC7's first 32 of two subsets), and the unquantize,
 * interpolate and finish steps the hardware is to answer bit for bit. The
 * device gate holds both to a GPU's own decoder.
 */

/**
 * The 64 partitions of two subsets: bit t set where texel t (x + 4y) is in
 * subset 1.
 */
const PARTITIONS_2 = Object.freeze([
    0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80,
    0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
    0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce,
    0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
    0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a,
    0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
    0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c,
    0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22,
]);

/** The 64 partitions of three subsets: the subset of each texel, row by row. */
const PARTITIONS_3 = Object.freeze([
    '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111',
    '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
    '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012',
    '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
    '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111',
    '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
    '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221',
    '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
    '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120',
    '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
    '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122',
    '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
    '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112',
    '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
    '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112',
    '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
].map(row=>Uint8Array.from(row, digit=>Number(digit))));

/** The fix-up texel of subset 1 in each partition of two subsets. */
const ANCHOR_2 = Object.freeze([
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
    15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
    15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
    6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
]);

/** The fix-up texels of subsets 1 and 2 in each partition of three subsets. */
const ANCHOR_3A = Object.freeze([
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
    3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
    8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
    3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
]);
const ANCHOR_3B = Object.freeze([
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
    15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
    15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
    15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
]);

const WEIGHTS = Object.freeze({
    2: [0, 21, 43, 64],
    3: [0, 9, 18, 27, 37, 46, 55, 64],
    4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
});

/**
 * A 128-bit block read a field at a time, from bit 0 up.
 *
 * @param {Uint8Array} bytes @param {number} at
 */
function bitReader(bytes, at){
    const words = [0, 1, 2, 3].map(k=>(bytes[at + 4 * k] | (bytes[at + 4 * k + 1] << 8)
        | (bytes[at + 4 * k + 2] << 16) | (bytes[at + 4 * k + 3] << 24)) >>> 0);
    let position = 0;
    /** @param {number} start @param {number} count at most 16 */
    const peek = (start, count)=>{
        const word = start >>> 5;
        const shift = start & 31;
        let value = words[word] >>> shift;
        if (shift + count > 32 && word < 3)
        {
            value |= words[word + 1] << (32 - shift);
        }
        return (value & ((1 << count) - 1)) >>> 0;
    };
    return {
        /** @param {number} count */
        read(count){
            const value = count === 0 ? 0 : peek(position, count);
            position += count;
            return value;
        },
        /** @param {number} to */
        seek(to){
            position = to;
        },
        get position(){
            return position;
        },
    };
}

/** BC7's modes: subsets, partition, rotation and index-selector bits,
 *  colour and alpha bits, P-bits per endpoint or per subset, index bits. */
const BC7_MODES = Object.freeze([
    { subsets: 3, partition: 4, rotation: 0, selector: 0, colour: 4, alpha: 0, endpointP: 1,
        sharedP: 0, index: 3, index2: 0 },
    { subsets: 2, partition: 6, rotation: 0, selector: 0, colour: 6, alpha: 0, endpointP: 0,
        sharedP: 1, index: 3, index2: 0 },
    { subsets: 3, partition: 6, rotation: 0, selector: 0, colour: 5, alpha: 0, endpointP: 0,
        sharedP: 0, index: 2, index2: 0 },
    { subsets: 2, partition: 6, rotation: 0, selector: 0, colour: 7, alpha: 0, endpointP: 1,
        sharedP: 0, index: 2, index2: 0 },
    { subsets: 1, partition: 0, rotation: 2, selector: 1, colour: 5, alpha: 6, endpointP: 0,
        sharedP: 0, index: 2, index2: 3 },
    { subsets: 1, partition: 0, rotation: 2, selector: 0, colour: 7, alpha: 8, endpointP: 0,
        sharedP: 0, index: 2, index2: 2 },
    { subsets: 1, partition: 0, rotation: 0, selector: 0, colour: 7, alpha: 7, endpointP: 1,
        sharedP: 0, index: 4, index2: 0 },
    { subsets: 2, partition: 6, rotation: 0, selector: 0, colour: 5, alpha: 5, endpointP: 1,
        sharedP: 0, index: 2, index2: 0 },
]);

/**
 * The subset of each texel and the fix-up texels of a partition.
 *
 * @param {number} subsets @param {number} partition
 * @returns {{ subsetOf: (texel: number) => number, anchors: number[] }}
 */
function partitionOf(subsets, partition){
    if (subsets === 1)
    {
        return { subsetOf: ()=>0, anchors: [0] };
    }
    if (subsets === 2)
    {
        const mask = PARTITIONS_2[partition];
        return { subsetOf: texel=>(mask >>> texel) & 1, anchors: [0, ANCHOR_2[partition]] };
    }
    const table = PARTITIONS_3[partition];
    return { subsetOf: texel=>table[texel],
        anchors: [0, ANCHOR_3A[partition], ANCHOR_3B[partition]] };
}

/**
 * The indices of a block's sixteen texels, `bits` each and one fewer at a
 * fix-up texel (its top bit is zero).
 *
 * @param {ReturnType<typeof bitReader>} reader @param {number} bits
 * @param {number[]} anchors
 */
function readIndices(reader, bits, anchors){
    const indices = new Uint8Array(16);
    for (let texel = 0; texel < 16; texel++)
    {
        indices[texel] = reader.read(anchors.includes(texel) ? bits - 1 : bits);
    }
    return indices;
}

/** @param {number} a @param {number} b @param {number} weight */
const interpolate = (a, b, weight)=>((64 - weight) * a + weight * b + 32) >> 6;

/**
 * One BC7 block's sixteen texels as RGBA bytes, row by row.
 *
 * @param {Uint8Array} bytes @param {number} at
 * @returns {Uint8Array} 64 bytes
 */
export function decodeBc7Block(bytes, at){
    const out = new Uint8Array(64);
    const reader = bitReader(bytes, at);
    let modeIndex = 0;
    while (modeIndex < 8 && reader.read(1) === 0)
    {
        modeIndex++;
    }
    if (modeIndex === 8)
    {
        // The reserved mode: every channel zero.
        return out;
    }
    const mode = BC7_MODES[modeIndex];
    const partition = reader.read(mode.partition);
    const rotation = reader.read(mode.rotation);
    const selector = reader.read(mode.selector);
    const endpoints = mode.subsets * 2;
    /** @type {number[][]} r, g, b, a per endpoint */
    const colours = Array.from({ length: endpoints }, ()=>[0, 0, 0, 255]);
    for (let channel = 0; channel < 3; channel++)
    {
        for (let e = 0; e < endpoints; e++)
        {
            colours[e][channel] = reader.read(mode.colour);
        }
    }
    for (let e = 0; e < endpoints && mode.alpha > 0; e++)
    {
        colours[e][3] = reader.read(mode.alpha);
    }
    /** @type {number[]} */
    const pBits = [];
    if (mode.endpointP)
    {
        for (let e = 0; e < endpoints; e++)
        {
            pBits.push(reader.read(1));
        }
    }
    else if (mode.sharedP)
    {
        for (let s = 0; s < mode.subsets; s++)
        {
            const p = reader.read(1);
            pBits.push(p, p);
        }
    }
    const colourBits = mode.colour + (pBits.length > 0 ? 1 : 0);
    const alphaBits = mode.alpha + (pBits.length > 0 && mode.alpha > 0 ? 1 : 0);
    /** @param {number} value @param {number} bits */
    const expand = (value, bits)=>{
        const wide = value << (8 - bits);
        return (wide | (wide >> bits)) & 0xff;
    };
    for (let e = 0; e < endpoints; e++)
    {
        for (let channel = 0; channel < 4; channel++)
        {
            if (channel === 3 && mode.alpha === 0)
            {
                continue;
            }
            const p = pBits.length > 0 ? pBits[e] : null;
            const raw = p === null ? colours[e][channel] : (colours[e][channel] << 1) | p;
            colours[e][channel] = expand(raw, channel === 3 ? alphaBits : colourBits);
        }
    }
    const { subsetOf, anchors } = partitionOf(mode.subsets, partition);
    const primary = readIndices(reader, mode.index, anchors);
    const secondary = mode.index2 ? readIndices(reader, mode.index2, [0]) : null;
    for (let texel = 0; texel < 16; texel++)
    {
        const subset = subsetOf(texel);
        const low = colours[2 * subset];
        const high = colours[2 * subset + 1];
        let colourIndex = primary[texel];
        let colourWeights = WEIGHTS[/** @type {2 | 3 | 4} */ (mode.index)];
        let alphaIndex = primary[texel];
        let alphaWeights = colourWeights;
        if (secondary)
        {
            const swapped = selector === 1;
            const secondWeights = WEIGHTS[/** @type {2 | 3 | 4} */ (mode.index2)];
            colourIndex = swapped ? secondary[texel] : primary[texel];
            colourWeights = swapped ? secondWeights : WEIGHTS[/** @type {2 | 3 | 4} */ (mode.index)];
            alphaIndex = swapped ? primary[texel] : secondary[texel];
            alphaWeights = swapped ? WEIGHTS[/** @type {2 | 3 | 4} */ (mode.index)] : secondWeights;
        }
        const texelOut = [0, 1, 2].map(channel=>interpolate(low[channel], high[channel],
            colourWeights[colourIndex]));
        texelOut.push(interpolate(low[3], high[3], alphaWeights[alphaIndex]));
        if (rotation)
        {
            const other = rotation - 1;
            [texelOut[other], texelOut[3]] = [texelOut[3], texelOut[other]];
        }
        out.set(texelOut, texel * 4);
    }
    return out;
}

/**
 * BC6H's modes by their mode bits: transformed or not, the base precision
 * and the delta bits of red, green and blue, and the header's fields in the
 * order its bits are laid out after the mode bits (a field, its top bit and
 * its bottom bit; a top below the bottom is a field written in reverse).
 */
const BC6H_LAYOUTS = (()=>{
    /** @typedef {[string, number, number]} Field */
    /** @param {string} text @returns {Field[]} */
    const fields = text=>text.trim().split(/\s+/).map(item=>{
        const match = /^([a-z]{2}|d)\[(\d+)(?::(\d+))?\]$/.exec(item);
        if (!match)
        {
            throw new Error(`bc6h: field ${item}`);
        }
        return [match[1], Number(match[2]), Number(match[3] ?? match[2])];
    });
    /** @param {boolean} transformed @param {number} precision @param {number[]} deltas
     *  @param {string} text */
    const mode = (transformed, precision, deltas, text)=>({ transformed, precision, deltas,
        fields: fields(text), regions: text.includes('d[') ? 2 : 1 });
    return new Map([
        [0, mode(true, 10, [5, 5, 5], 'gy[4] by[4] bz[4] rw[9:0] gw[9:0] bw[9:0] rx[4:0] gz[4]'
            + ' gy[3:0] gx[4:0] bz[0] gz[3:0] bx[4:0] bz[1] by[3:0] ry[4:0] bz[2] rz[4:0] bz[3]'
            + ' d[4:0]')],
        [1, mode(true, 7, [6, 6, 6], 'gy[5] gz[4] gz[5] rw[6:0] bz[0] bz[1] by[4] gw[6:0] by[5]'
            + ' bz[2] gy[4] bw[6:0] bz[3] bz[5] bz[4] rx[5:0] gy[3:0] gx[5:0] gz[3:0] bx[5:0]'
            + ' by[3:0] ry[5:0] rz[5:0] d[4:0]')],
        [2, mode(true, 11, [5, 4, 4], 'rw[9:0] gw[9:0] bw[9:0] rx[4:0] rw[10] gy[3:0] gx[3:0]'
            + ' gw[10] bz[0] gz[3:0] bx[3:0] bw[10] bz[1] by[3:0] ry[4:0] bz[2] rz[4:0] bz[3]'
            + ' d[4:0]')],
        [6, mode(true, 11, [4, 5, 4], 'rw[9:0] gw[9:0] bw[9:0] rx[3:0] rw[10] gz[4] gy[3:0]'
            + ' gx[4:0] gw[10] gz[3:0] bx[3:0] bw[10] bz[1] by[3:0] ry[3:0] bz[0] bz[2] rz[3:0]'
            + ' gy[4] bz[3] d[4:0]')],
        [10, mode(true, 11, [4, 4, 5], 'rw[9:0] gw[9:0] bw[9:0] rx[3:0] rw[10] by[4] gy[3:0]'
            + ' gx[3:0] gw[10] bz[0] gz[3:0] bx[4:0] bw[10] by[3:0] ry[3:0] bz[1] bz[2]'
            + ' rz[3:0] bz[4] bz[3] d[4:0]')],
        [14, mode(true, 9, [5, 5, 5], 'rw[8:0] by[4] gw[8:0] gy[4] bw[8:0] bz[4] rx[4:0] gz[4]'
            + ' gy[3:0] gx[4:0] bz[0] gz[3:0] bx[4:0] bz[1] by[3:0] ry[4:0] bz[2] rz[4:0] bz[3]'
            + ' d[4:0]')],
        [18, mode(true, 8, [6, 5, 5], 'rw[7:0] gz[4] by[4] gw[7:0] bz[2] gy[4] bw[7:0] bz[3]'
            + ' bz[4] rx[5:0] gy[3:0] gx[4:0] bz[0] gz[3:0] bx[4:0] bz[1] by[3:0] ry[5:0]'
            + ' rz[5:0] d[4:0]')],
        [22, mode(true, 8, [5, 6, 5], 'rw[7:0] bz[0] by[4] gw[7:0] gy[5] gy[4] bw[7:0] gz[5]'
            + ' bz[4] rx[4:0] gz[4] gy[3:0] gx[5:0] gz[3:0] bx[4:0] bz[1] by[3:0] ry[4:0] bz[2]'
            + ' rz[4:0] bz[3] d[4:0]')],
        [26, mode(true, 8, [5, 5, 6], 'rw[7:0] bz[1] by[4] gw[7:0] by[5] gy[4] bw[7:0] bz[5]'
            + ' bz[4] rx[4:0] gz[4] gy[3:0] gx[4:0] bz[0] gz[3:0] bx[5:0] by[3:0] ry[4:0] bz[2]'
            + ' rz[4:0] bz[3] d[4:0]')],
        [30, mode(false, 6, [6, 6, 6], 'rw[5:0] gz[4] bz[0] bz[1] by[4] gw[5:0] gy[5] by[5]'
            + ' bz[2] gy[4] bw[5:0] gz[5] bz[3] bz[5] bz[4] rx[5:0] gy[3:0] gx[5:0] gz[3:0]'
            + ' bx[5:0] by[3:0] ry[5:0] rz[5:0] d[4:0]')],
        [3, mode(false, 10, [10, 10, 10], 'rw[9:0] gw[9:0] bw[9:0] rx[9:0] gx[9:0] bx[9:0]')],
        [7, mode(true, 11, [9, 9, 9], 'rw[9:0] gw[9:0] bw[9:0] rx[8:0] rw[10] gx[8:0] gw[10]'
            + ' bx[8:0] bw[10]')],
        [11, mode(true, 12, [8, 8, 8], 'rw[9:0] gw[9:0] bw[9:0] rx[7:0] rw[10:11] gx[7:0]'
            + ' gw[10:11] bx[7:0] bw[10:11]')],
        [15, mode(true, 16, [4, 4, 4], 'rw[9:0] gw[9:0] bw[9:0] rx[3:0] rw[10:15] gx[3:0]'
            + ' gw[10:15] bx[3:0] bw[10:15]')],
    ]);
})();

/** @param {number} value @param {number} bits */
const signExtend = (value, bits)=>(bits >= 32 ? value : (value << (32 - bits)) >> (32 - bits));

/**
 * @param {number} value @param {number} bits @param {boolean} signed
 * @returns {number}
 */
function unquantize(value, bits, signed){
    if (!signed)
    {
        if (bits >= 15)
        {
            return value;
        }
        if (value === 0)
        {
            return 0;
        }
        if (value === (1 << bits) - 1)
        {
            return 0xffff;
        }
        return ((value << 16) + 0x8000) >> bits;
    }
    if (bits >= 16)
    {
        return value;
    }
    const negative = value < 0;
    const magnitude = negative ? -value : value;
    let result;
    if (magnitude === 0)
    {
        result = 0;
    }
    else if (magnitude >= (1 << (bits - 1)) - 1)
    {
        result = 0x7fff;
    }
    else
    {
        result = ((magnitude << 15) + 0x4000) >> (bits - 1);
    }
    return negative ? -result : result;
}

/** @param {number} value @param {boolean} signed @returns {number} the half's bits */
function finishUnquantize(value, signed){
    if (!signed)
    {
        return ((value * 31) >> 6) & 0xffff;
    }
    const scaled = value < 0 ? -(((-value) * 31) >> 5) : (value * 31) >> 5;
    return scaled < 0 ? 0x8000 | -scaled : scaled;
}

/**
 * One BC6H block's sixteen texels as RGBA halves (alpha 1.0), row by row.
 *
 * @param {Uint8Array} bytes @param {number} at @param {boolean} signed
 * @returns {Uint16Array} 64 halves
 */
export function decodeBc6hBlock(bytes, at, signed){
    const out = new Uint16Array(64);
    const reader = bitReader(bytes, at);
    let modeBits = reader.read(2);
    if (modeBits > 1)
    {
        modeBits |= reader.read(3) << 2;
    }
    const layout = BC6H_LAYOUTS.get(modeBits);
    if (!layout)
    {
        // A reserved mode: zero in every channel but alpha.
        for (let texel = 0; texel < 16; texel++)
        {
            out[texel * 4 + 3] = 0x3c00;
        }
        return out;
    }
    /** @type {Record<string, number>} */
    const value = { rw: 0, gw: 0, bw: 0, rx: 0, gx: 0, bx: 0, ry: 0, gy: 0, by: 0, rz: 0,
        gz: 0, bz: 0, d: 0 };
    for (const [name, high, low] of layout.fields)
    {
        if (high >= low)
        {
            value[name] |= reader.read(high - low + 1) << low;
        }
        else
        {
            // Written in reverse: the first bit read is the field's top.
            for (let bit = low; bit >= high; bit--)
            {
                value[name] |= reader.read(1) << bit;
            }
        }
    }
    const regions = layout.regions;
    /** @type {number[][]} A0, B0, A1, B1, each r, g, b */
    const ends = [['rw', 'gw', 'bw'], ['rx', 'gx', 'bx'], ['ry', 'gy', 'by'], ['rz', 'gz', 'bz']]
        .slice(0, regions * 2).map(names=>names.map(name=>value[name]));
    const precision = layout.precision;
    const mask = (1 << precision) - 1;
    for (let channel = 0; channel < 3; channel++)
    {
        if (signed)
        {
            ends[0][channel] = signExtend(ends[0][channel], precision);
        }
        if (layout.transformed || signed)
        {
            for (let e = 1; e < ends.length; e++)
            {
                ends[e][channel] = signExtend(ends[e][channel], layout.deltas[channel]);
            }
        }
        if (layout.transformed)
        {
            for (let e = 1; e < ends.length; e++)
            {
                ends[e][channel] = (ends[e][channel] + ends[0][channel]) & mask;
                if (signed)
                {
                    ends[e][channel] = signExtend(ends[e][channel], precision);
                }
            }
        }
    }
    const { subsetOf, anchors } = regions === 2
        ? partitionOf(2, value.d) : partitionOf(1, 0);
    reader.seek(regions === 2 ? 82 : 65);
    const bits = regions === 2 ? 3 : 4;
    const indices = readIndices(reader, bits, anchors);
    const weights = WEIGHTS[/** @type {3 | 4} */ (bits)];
    for (let texel = 0; texel < 16; texel++)
    {
        const subset = subsetOf(texel);
        const low = ends[2 * subset];
        const high = ends[2 * subset + 1];
        for (let channel = 0; channel < 3; channel++)
        {
            const a = unquantize(low[channel], precision, signed);
            const b = unquantize(high[channel], precision, signed);
            out[texel * 4 + channel] = finishUnquantize(
                (a * (64 - weights[indices[texel]]) + b * weights[indices[texel]] + 32) >> 6,
                signed);
        }
        out[texel * 4 + 3] = 0x3c00;
    }
    return out;
}

/**
 * A subresource of BC6H or BC7 blocks decoded: BC7 into RGBA bytes, BC6H into
 * RGBA halves (as bytes), row by row; null when the bytes are too few.
 *
 * @param {Uint8Array} bytes @param {'bc6hu' | 'bc6hs' | 'bc7'} kind
 * @param {number} width @param {number} height
 * @returns {Uint8Array | null}
 */
export function decodeBc67(bytes, kind, width, height){
    const across = Math.ceil(width / 4);
    const down = Math.ceil(height / 4);
    if (bytes.length < across * down * 16)
    {
        return null;
    }
    const texelBytes = kind === 'bc7' ? 4 : 8;
    const out = new Uint8Array(width * height * texelBytes);
    for (let by = 0; by < down; by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            const at = (by * across + bx) * 16;
            const block = kind === 'bc7'
                ? decodeBc7Block(bytes, at)
                : new Uint8Array(decodeBc6hBlock(bytes, at, kind === 'bc6hs').buffer);
            for (let y = 0; y < 4 && by * 4 + y < height; y++)
            {
                for (let x = 0; x < 4 && bx * 4 + x < width; x++)
                {
                    const texel = y * 4 + x;
                    out.set(block.subarray(texel * texelBytes, (texel + 1) * texelBytes),
                        ((by * 4 + y) * width + bx * 4 + x) * texelBytes);
                }
            }
        }
    }
    return out;
}
