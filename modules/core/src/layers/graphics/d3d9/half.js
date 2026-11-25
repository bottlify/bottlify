/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { fromHalf, toHalf } from '../../../system/floats.js';

/**
 * A wide surface's channels to and from the half-precision floats (IEEE 754
 * binary16) the GPU holds them in; a half itself is system/floats.js's.
 */

/**
 * Channels as a wide surface format keeps them in memory, as the half floats
 * the GPU holds them in: a half as it lies, a 32-bit float rounded to the
 * nearest half, a 16-bit fraction as the half nearest its value.
 *
 * A 16-bit fraction loses bits on the way: a half has eleven significant
 * bits, so between one half and one a step is 1/2048 where the fraction's is
 * 1/65535. A half's steps shrink with its value, and below 1/64 -- near black,
 * where banding shows -- the half is the finer of the two.
 *
 * @param {'half' | 'float' | 'unorm16'} stored
 * @param {Uint8Array} bytes  as they lie in memory, at any alignment
 * @param {number} count  channels
 * @returns {Uint8Array} `count` halves, little-endian
 */
export function storedToHalves(stored, bytes, count){
    if (stored === 'half')
    {
        return bytes.slice(0, count * 2);
    }
    const from = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Uint16Array(count);
    for (let index = 0; index < count; index++)
    {
        out[index] = toHalf(stored === 'float'
            ? from.getFloat32(index * 4, true)
            : from.getUint16(index * 2, true) / 0xffff);
    }
    return new Uint8Array(out.buffer);
}

/**
 * Half floats as the GPU holds them, back into the channels of the format a
 * program asked for. A fraction takes the nearest of its 65536 steps, and a
 * value a draw left outside 0..1 -- a half target does not clamp what it is
 * given, where a fixed-point one would -- is clamped here, as reading it from
 * that target would have.
 *
 * @param {'half' | 'float' | 'unorm16'} stored
 * @param {Uint8Array} halves  little-endian, at any alignment
 * @param {number} count  channels
 * @returns {Uint8Array} the bytes `count` channels occupy in memory
 */
export function halvesToStored(stored, halves, count){
    if (stored === 'half')
    {
        return halves.slice(0, count * 2);
    }
    const from = new DataView(halves.buffer, halves.byteOffset, halves.byteLength);
    const out = new DataView(new ArrayBuffer(count * (stored === 'float' ? 4 : 2)));
    for (let index = 0; index < count; index++)
    {
        const value = fromHalf(from.getUint16(index * 2, true));
        if (stored === 'float')
        {
            out.setFloat32(index * 4, value, true);
        }
        else
        {
            // NaN fails both comparisons and is zero, as a fixed-point target stores it.
            const clamped = value > 0 ? Math.min(value, 1) : 0;
            out.setUint16(index * 2, Math.round(clamped * 0xffff), true);
        }
    }
    return new Uint8Array(out.buffer);
}
