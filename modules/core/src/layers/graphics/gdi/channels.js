/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Pixels whose red, green and blue are named by three masks, as a
 * BI_BITFIELDS bitmap's are: to and from the 0x00RRGGBB this layer draws in.
 *
 * A channel goes into its mask as its top bits, a wider mask's low bits
 * left zero, and comes back widened to eight bits by repeating its own, so
 * that full scale stays full scale: a shift alone reads five-bit white as
 * 0xf8.
 */

/**
 * @typedef {Object} Channel
 * @property {number} mask
 * @property {number} shift  Where the mask's run of bits starts.
 * @property {number} bits   How many bits the run is; zero for an empty mask.
 */

/**
 * The channels three masks describe, red first. A mask is one run of bits,
 * as the format requires; an empty one is a channel that is always zero.
 *
 * @param {readonly number[]} masks
 * @returns {Channel[]}
 */
export function channelsOf(masks){
    return [0, 1, 2].map(index=>{
        const mask = (masks[index] ?? 0) >>> 0;
        let shift = 0;
        while (shift < 32 && ((mask >>> shift) & 1) === 0)
        {
            shift++;
        }
        let bits = 0;
        while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1)
        {
            bits++;
        }
        return { mask, shift, bits };
    });
}

/**
 * @param {number} value  The masked pixel.
 * @param {Channel} channel
 * @returns {number} the channel, eight bits wide
 */
function widen(value, channel){
    const bits = channel.bits;
    if (bits === 0)
    {
        return 0;
    }
    const field = ((value & channel.mask) >>> 0) >>> channel.shift;
    if (bits >= 8)
    {
        return (field >>> (bits - 8)) & 0xff;
    }
    let wide = field;
    let filled = bits;
    while (filled < 8)
    {
        wide = (wide << bits) | field;
        filled += bits;
    }
    return (wide >>> (filled - 8)) & 0xff;
}

/**
 * @param {number} eight  A channel, eight bits wide.
 * @param {Channel} channel
 * @returns {number} it in its mask
 */
function narrow(eight, channel){
    const bits = channel.bits;
    if (bits === 0)
    {
        return 0;
    }
    const field = bits >= 8 ? eight * (2 ** (bits - 8)) : eight >>> (8 - bits);
    return (field * (2 ** channel.shift)) & channel.mask;
}

/**
 * @param {number} value  A masked pixel.
 * @param {Channel[]} channels
 * @returns {number} 0x00RRGGBB
 */
export function unpackPixel(value, channels){
    return ((widen(value, channels[0]) << 16) | (widen(value, channels[1]) << 8)
        | widen(value, channels[2])) >>> 0;
}

/**
 * @param {number} pixel  0x00RRGGBB
 * @param {Channel[]} channels
 * @returns {number} the masked pixel
 */
export function packPixel(pixel, channels){
    return (narrow((pixel >>> 16) & 0xff, channels[0]) | narrow((pixel >>> 8) & 0xff, channels[1])
        | narrow(pixel & 0xff, channels[2])) >>> 0;
}
