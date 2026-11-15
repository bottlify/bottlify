/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An icon's or cursor's two bitmaps as Windows keeps them: the monochrome
 * mask, and the colour drawn where the mask is clear - or, for a monochrome
 * icon, no colour and a mask twice as tall, its AND half above its XOR half.
 * GetIconInfo hands both out as bitmaps the caller owns, and a program reads
 * them back bit for bit, so they are kept as given rather than rebuilt from
 * the picture the page draws.
 *
 * The mask is in CreateBitmap's layout (rows top-down, padded to a WORD); the
 * colour is 32-bit, blue green red and a fourth byte, the display's depth.
 */

/**
 * @typedef {Object} IconBits
 * @property {number} width
 * @property {number} height   The icon's height; a monochrome mask is twice it.
 * @property {number} [maskHeight]  The mask's lines where they are not that:
 *           a monochrome mask of an odd height, as CreateIconIndirect took it.
 * @property {Uint8Array} mask
 * @property {Uint8Array | null} colour
 */

/** @param {number} width @returns {number} a monochrome row's bytes */
export const maskStride = width=>((width + 15) >>> 4) * 2;

/**
 * The bits an icon drawn from a picture has: the mask set where the picture
 * is transparent, the colour black there, as an icon loaded from a resource
 * is masked.
 *
 * @param {{ width: number, height: number, bgra: Uint8Array | Uint8ClampedArray }} picture
 * @returns {IconBits}
 */
export function bitsFromPicture({ width, height, bgra }){
    const stride = maskStride(width);
    const mask = new Uint8Array(stride * height);
    const colour = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const at = (y * width + x) * 4;
            if (bgra[at + 3] === 0)
            {
                mask[y * stride + (x >>> 3)] |= 0x80 >>> (x & 7);
                continue;
            }
            colour.set([bgra[at], bgra[at + 1], bgra[at + 2], 0], at);
        }
    }
    return { width, height, mask, colour };
}

/**
 * The bits of an icon nothing is known of but its size: all of it the colour
 * black, drawn opaque.
 *
 * @param {number} width @param {number} height
 * @returns {IconBits}
 */
export function blankBits(width, height){
    return { width, height, mask: new Uint8Array(maskStride(width) * height),
        colour: new Uint8Array(width * height * 4) };
}

/**
 * A monochrome mask made of a bitmap's pixels read as GetDIBits reads them:
 * a pixel is set where it is white, as Windows converts a colour mask by
 * the background white of a monochrome blit.
 *
 * @param {{ width: number, height: number, bgra: Uint8Array }} pixels
 * @returns {Uint8Array}
 */
export function maskFromPixels({ width, height, bgra }){
    const stride = maskStride(width);
    const mask = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const at = (y * width + x) * 4;
            if (bgra[at] === 0xff && bgra[at + 1] === 0xff && bgra[at + 2] === 0xff)
            {
                mask[y * stride + (x >>> 3)] |= 0x80 >>> (x & 7);
            }
        }
    }
    return mask;
}

/**
 * The picture the page draws of the bits: transparent where the mask is set,
 * the colour elsewhere - for a monochrome icon, white where its XOR half is
 * set and black where it is clear. The screen a set XOR bit would invert
 * under a set mask bit cannot be said in a picture and is transparent.
 *
 * @param {IconBits} bits @param {{ x: number, y: number }} hotSpot
 */
export function pictureFromBits(bits, hotSpot){
    const { width, height, mask, colour } = bits;
    const stride = maskStride(width);
    const bgra = new Uint8Array(width * height * 4);
    /** @param {number} row @param {number} x */
    const bit = (row, x)=>(mask[row * stride + (x >>> 3)] & (0x80 >>> (x & 7))) !== 0;
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            if (bit(y, x))
            {
                continue;
            }
            const at = (y * width + x) * 4;
            if (colour)
            {
                bgra.set([colour[at], colour[at + 1], colour[at + 2], 0xff], at);
            }
            else
            {
                const white = bit(y + height, x) ? 0xff : 0;
                bgra.set([white, white, white, 0xff], at);
            }
        }
    }
    return { width, height, hotSpot, bgra };
}

/**
 * The bits stretched to another size, nearest pixel, as CopyImage gives an
 * icon a size of its own: each half of a monochrome mask stretched apart.
 *
 * @param {IconBits} bits @param {number} width @param {number} height
 * @returns {IconBits}
 */
export function scaleBits(bits, width, height){
    if (width === bits.width && height === bits.height)
    {
        return bits;
    }
    const from = maskStride(bits.width);
    const to = maskStride(width);
    const halves = bits.colour ? 1 : 2;
    const mask = new Uint8Array(to * height * halves);
    for (let half = 0; half < halves; half++)
    {
        for (let y = 0; y < height; y++)
        {
            const sy = half * bits.height + Math.floor((y * bits.height) / height);
            for (let x = 0; x < width; x++)
            {
                const sx = Math.floor((x * bits.width) / width);
                if ((bits.mask[sy * from + (sx >>> 3)] & (0x80 >>> (sx & 7))) !== 0)
                {
                    mask[(half * height + y) * to + (x >>> 3)] |= 0x80 >>> (x & 7);
                }
            }
        }
    }
    let colour = null;
    if (bits.colour)
    {
        colour = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
        {
            const sy = Math.floor((y * bits.height) / height);
            for (let x = 0; x < width; x++)
            {
                const sx = Math.floor((x * bits.width) / width);
                const at = (sy * bits.width + sx) * 4;
                colour.set(bits.colour.subarray(at, at + 4), (y * width + x) * 4);
            }
        }
    }
    return { width, height, mask, colour };
}
