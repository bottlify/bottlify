/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The smaller pictures a bottle's cover is kept as. The library's card shows a
 * preview and the details panel a larger one, and neither needs a cover the
 * size it is found at: a catalogue's poster is 1200 by 1800 pixels and half a
 * megabyte, and a grid of them is the first thing the library loads.
 *
 * A JPEG is decoded, fitted into a box by averaging the area each new pixel
 * covers, and coded again as a baseline JPEG (ITU-T T.81) with the example
 * tables of the standard's Annex K: the Huffman tables as they stand, the
 * quantisation tables halved -- which the annex says gives a picture "nearly
 * indistinguishable from the source" -- and the colour at half the resolution
 * each way.
 */

import { decodeJpeg, ZIGZAG } from '@bottlify/core/jpeg';

/** Annex K, tables K.1 and K.2, halved: luminance and chrominance, natural order. */
const QUANT = [[
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
], [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    ...new Array(32).fill(99),
]].map(table=>table.map(q=>Math.max(1, Math.round(q / 2))));

/**
 * Annex K, tables K.3 to K.6: the DC and AC tables for luminance, then for
 * chrominance, each as the counts of codes of each length and the symbols in
 * code order -- what a DHT segment carries.
 */
const HUFFMAN = [
    {
        dc: { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
            symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        ac: { counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], symbols: [
            0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51,
            0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1,
            0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18,
            0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
            0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57,
            0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
            0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
            0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
            0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
            0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
            0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2,
            0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] },
    },
    {
        dc: { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
            symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        ac: { counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], symbols: [
            0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07,
            0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09,
            0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25,
            0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
            0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
            0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
            0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
            0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
            0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
            0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2,
            0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] },
    },
];

/**
 * The codes of a table, by symbol (Annex C): canonical, each length's codes
 * following the last of the length before.
 *
 * @param {{ counts: number[], symbols: number[] }} table
 */
function codesOf({ counts, symbols }){
    const codes = new Uint16Array(256);
    const lengths = new Uint8Array(256);
    let code = 0;
    let k = 0;
    for (let length = 1; length <= 16; length++)
    {
        for (let i = 0; i < counts[length - 1]; i++, k++)
        {
            codes[symbols[k]] = code++;
            lengths[symbols[k]] = length;
        }
        code <<= 1;
    }
    return { codes, lengths };
}

const CODES = HUFFMAN.map(({ dc, ac })=>({ dc: codesOf(dc), ac: codesOf(ac) }));

/** The DCT's basis: BASIS[u * 8 + x] = C(u) / 2 * cos((2x + 1) u pi / 16). */
const BASIS = new Float64Array(64);
for (let u = 0; u < 8; u++)
{
    for (let x = 0; x < 8; x++)
    {
        BASIS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16);
    }
}

/**
 * @typedef {Object} Plane
 * @property {Uint8Array} data  width * height samples, top-down.
 * @property {number} width
 * @property {number} height
 */

/**
 * A baseline JPEG of a YCbCr picture: luminance at full size, each chrominance
 * plane at half the width and height, rounded up (sampling 2x2, 1x1, 1x1).
 *
 * @param {number} width
 * @param {number} height
 * @param {[Plane, Plane, Plane]} planes  Y, Cb, Cr.
 * @returns {Uint8Array}
 */
export function encodeJpeg(width, height, planes){
    /** @type {number[]} */
    const out = [0xff, 0xd8];
    const segment = (/** @type {number} */ marker, /** @type {number[]} */ body)=>{
        out.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
    };
    // JFIF: the components are YCbCr, the pixels square.
    segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    segment(0xdb, QUANT.flatMap((table, id)=>[id, ...Array.from(ZIGZAG, at=>table[at])]));
    segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff,
        3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    segment(0xc4, HUFFMAN.flatMap(({ dc, ac }, id)=>[
        id, ...dc.counts, ...dc.symbols, 0x10 | id, ...ac.counts, ...ac.symbols]));
    segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

    let pending = 0;
    let pendingBits = 0;
    const put = (/** @type {number} */ value, /** @type {number} */ bits)=>{
        pending = (pending << bits) | value;
        pendingBits += bits;
        while (pendingBits >= 8)
        {
            pendingBits -= 8;
            const byte = (pending >>> pendingBits) & 0xff;
            out.push(byte);
            if (byte === 0xff)
            {
                out.push(0);
            }
        }
        pending &= (1 << pendingBits) - 1;
    };

    const samples = new Float64Array(64);
    const rows = new Float64Array(64);
    const predictions = [0, 0, 0];
    /**
     * One block of a component, its edges repeated past the picture.
     *
     * @param {number} component @param {number} bx @param {number} by
     */
    const codeBlock = (component, bx, by)=>{
        const plane = planes[component];
        for (let y = 0; y < 8; y++)
        {
            const row = Math.min(by * 8 + y, plane.height - 1) * plane.width;
            for (let x = 0; x < 8; x++)
            {
                samples[y * 8 + x] = plane.data[row + Math.min(bx * 8 + x, plane.width - 1)] - 128;
            }
        }
        // The forward DCT (A.3.3), a row pass and a column pass.
        for (let y = 0; y < 8; y++)
        {
            for (let u = 0; u < 8; u++)
            {
                let sum = 0;
                for (let x = 0; x < 8; x++)
                {
                    sum += BASIS[u * 8 + x] * samples[y * 8 + x];
                }
                rows[y * 8 + u] = sum;
            }
        }
        const table = component === 0 ? 0 : 1;
        const quant = QUANT[table];
        const { dc, ac } = CODES[table];
        let run = 0;
        for (let k = 0; k < 64; k++)
        {
            const at = ZIGZAG[k];
            const v = at >> 3;
            const u = at & 7;
            let sum = 0;
            for (let y = 0; y < 8; y++)
            {
                sum += BASIS[v * 8 + y] * rows[y * 8 + u];
            }
            const value = Math.round(sum / quant[at]);
            const coded = k === 0 ? value - predictions[component] : value;
            if (k === 0)
            {
                predictions[component] = value;
            }
            else if (coded === 0)
            {
                run++;
                continue;
            }
            const size = coded === 0 ? 0 : 32 - Math.clz32(Math.abs(coded));
            if (k === 0)
            {
                put(dc.codes[size], dc.lengths[size]);
            }
            else
            {
                for (; run > 15; run -= 16)
                {
                    put(ac.codes[0xf0], ac.lengths[0xf0]);
                }
                const symbol = (run << 4) | size;
                put(ac.codes[symbol], ac.lengths[symbol]);
                run = 0;
            }
            // A negative value is sent as its ones' complement in `size` bits (F.1.2.1).
            put(coded < 0 ? coded + (1 << size) - 1 : coded, size);
        }
        if (run > 0)
        {
            put(ac.codes[0x00], ac.lengths[0x00]);
        }
    };

    for (let my = 0; my < Math.ceil(height / 16); my++)
    {
        for (let mx = 0; mx < Math.ceil(width / 16); mx++)
        {
            codeBlock(0, mx * 2, my * 2);
            codeBlock(0, mx * 2 + 1, my * 2);
            codeBlock(0, mx * 2, my * 2 + 1);
            codeBlock(0, mx * 2 + 1, my * 2 + 1);
            codeBlock(1, mx, my);
            codeBlock(2, mx, my);
        }
    }
    if (pendingBits > 0)
    {
        put((1 << (8 - pendingBits)) - 1, 8 - pendingBits);
    }
    out.push(0xff, 0xd9);
    return Uint8Array.from(out);
}

/**
 * For each new pixel along one axis, the old pixels under it and how much of
 * each, the run starting at `index * scale`.
 *
 * @param {number} from  How many old pixels there are.
 * @param {number} count  How many new ones.
 * @param {number} scale  How many old pixels one new one spans.
 */
function spans(from, count, scale){
    return Array.from({ length: count }, (_, index)=>{
        const start = index * scale;
        const end = Math.min(from, start + scale);
        /** @type {number[]} */
        const taps = [];
        let total = 0;
        for (let at = Math.floor(start); at < end; at++)
        {
            const weight = Math.min(end, at + 1) - Math.max(start, at);
            taps.push(at, weight);
            total += weight;
        }
        return { taps, total };
    });
}

/**
 * One channel of an interleaved picture, made `width` by `height`, each new
 * pixel the average of the area it covers.
 *
 * @param {{ width: number, height: number, components: number, samples: Uint8Array }} picture
 * @param {number} channel
 * @param {number} width
 * @param {number} height
 * @param {number} scaleX  How many old pixels a new one spans across.
 * @param {number} scaleY  And down.
 * @returns {Plane}
 */
function resample(picture, channel, width, height, scaleX, scaleY){
    const { samples, components } = picture;
    const across = spans(picture.width, width, scaleX);
    const down = spans(picture.height, height, scaleY);
    const rows = new Float64Array(width * picture.height);
    for (let y = 0; y < picture.height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const { taps, total } = across[x];
            let sum = 0;
            for (let k = 0; k < taps.length; k += 2)
            {
                sum += samples[(y * picture.width + taps[k]) * components + channel] * taps[k + 1];
            }
            rows[y * width + x] = sum / total;
        }
    }
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
    {
        const { taps, total } = down[y];
        for (let x = 0; x < width; x++)
        {
            let sum = 0;
            for (let k = 0; k < taps.length; k += 2)
            {
                sum += rows[taps[k] * width + x] * taps[k + 1];
            }
            data[y * width + x] = Math.round(sum / total);
        }
    }
    return { data, width, height };
}

/**
 * A JPEG picture fitted into a box, kept to its shape and never enlarged, or
 * null for one this does not read: another format, or four components or RGB,
 * which would need a colour conversion first. One already inside the box is
 * answered as it is unless coding it again makes it smaller.
 *
 * @param {Uint8Array} bytes
 * @param {number} boxWidth
 * @param {number} boxHeight
 * @returns {Uint8Array | null}
 */
export function fitJpeg(bytes, boxWidth, boxHeight){
    let picture;
    try
    {
        picture = decodeJpeg(bytes);
    }
    catch {
        return null;
    }
    const { components } = picture;
    if (components !== 1 && (components !== 3 || (picture.adobe && picture.transform === 0)))
    {
        return null;
    }
    const scale = Math.min(1, boxWidth / picture.width, boxHeight / picture.height);
    const width = Math.max(1, Math.round(picture.width * scale));
    const height = Math.max(1, Math.round(picture.height * scale));
    const halfWidth = (width + 1) >> 1;
    const halfHeight = (height + 1) >> 1;
    /** @param {number} channel @returns {Plane} */
    const chroma = channel=>(components === 1
        ? { data: new Uint8Array(halfWidth * halfHeight).fill(128), width: halfWidth,
            height: halfHeight }
        : resample(picture, channel, halfWidth, halfHeight, 2 * picture.width / width,
            2 * picture.height / height));
    const fitted = encodeJpeg(width, height, [
        resample(picture, 0, width, height, picture.width / width, picture.height / height),
        chroma(1), chroma(2),
    ]);
    return scale === 1 && fitted.length >= bytes.length ? bytes : fitted;
}
