/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { DDPF_ALPHAPIXELS, DDPF_FOURCC, DDPF_RGB, DXT_CODES } from '../ddraw/constants.js';

/**
 * @param {number} bitCount @param {number} red @param {number} green @param {number} blue
 * @param {number} alpha
 */
const rgbFormat = (bitCount, red, green, blue, alpha)=>Object.freeze({
    size: 0x20, flags: DDPF_RGB | (alpha !== 0 ? DDPF_ALPHAPIXELS : 0), fourCC: 0, bitCount,
    redMask: red, greenMask: green, blueMask: blue, alphaMask: alpha,
});

/**
 * The texture formats EnumTextureFormats names: the ones the renderer uploads
 * (d3d7/device.js d3dFormatOf), each by its own masks, as a driver of the era
 * named them. A program picks its formats by those masks -- one with alpha for
 * what it blends, 5-5-5 or 4-4-4-4 -- and gives up when the one it looks for
 * is not offered.
 */
export const TEXTURE_FORMATS = Object.freeze([
    rgbFormat(32, 0x00ff0000, 0x0000ff00, 0x000000ff, 0),
    rgbFormat(32, 0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000),
    rgbFormat(16, 0xf800, 0x07e0, 0x001f, 0),
    rgbFormat(16, 0x7c00, 0x03e0, 0x001f, 0),
    rgbFormat(16, 0x7c00, 0x03e0, 0x001f, 0x8000),
    rgbFormat(16, 0x0f00, 0x00f0, 0x000f, 0xf000),
    // DXT1 to DXT5, by FOURCC alone.
    ...DXT_CODES.map(fourCC=>Object.freeze({ size: 0x20, flags: DDPF_FOURCC, fourCC,
        bitCount: 0, redMask: 0, greenMask: 0, blueMask: 0, alphaMask: 0 })),
]);

/**
 * Whether a texture can be made in a format on the device: one of those
 * EnumTextureFormats names, compared by every field a program fills in.
 *
 * @param {{ flags: number, fourCC: number, bitCount: number, redMask: number,
 *     greenMask: number, blueMask: number, alphaMask: number }} format
 * @returns {boolean}
 */
export function textureFormatOffered(format){
    return TEXTURE_FORMATS.some(offered=>(format.flags & DDPF_FOURCC) !== 0
        ? (offered.flags & DDPF_FOURCC) !== 0 && offered.fourCC === format.fourCC >>> 0
        : offered.flags === (format.flags & (DDPF_RGB | DDPF_ALPHAPIXELS))
            && (format.flags & ~(DDPF_RGB | DDPF_ALPHAPIXELS)) === 0
            && offered.bitCount === format.bitCount
            && offered.redMask === format.redMask >>> 0
            && offered.greenMask === format.greenMask >>> 0
            && offered.blueMask === format.blueMask >>> 0
            && offered.alphaMask === ((format.flags & DDPF_ALPHAPIXELS) !== 0
                ? format.alphaMask >>> 0 : 0));
}
