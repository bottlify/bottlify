/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A DirectDraw depth buffer's bytes as the depths and stencils the GPU keeps,
 * and back. The pixel format names the layout: the depth in the bits of
 * dwZBitMask (where DirectDraw's DDPIXELFORMAT keeps it, the green mask's
 * place), the stencil in those of dwStencilBitMask (the blue mask's), the
 * pixel as wide as its bit count says, little-endian. A depth of 0 to 1 is
 * that share of the mask's range, rounded, as a fixed-point depth buffer
 * holds it (Wine's test_depth_readback: D16, D24 in three bytes, D24X8,
 * D24S8, and 32 bits of depth).
 */

/**
 * @typedef {Object} DepthFormat
 * @property {number} bitCount   dwZBufferBitDepth
 * @property {number} greenMask  dwZBitMask
 * @property {number} blueMask   dwStencilBitMask
 */

/**
 * @typedef {Object} DepthPixels
 * @property {number} width
 * @property {number} height
 * @property {number} pitch          bytes a row
 * @property {number} bytesPerPixel
 */

/** @param {number} mask @returns {number} the lowest set bit's place, 0 for none */
const shiftOf = mask=>(mask === 0 ? 0 : 31 - Math.clz32(mask & -mask));

/**
 * Where a format keeps its depth and stencil: each as a shift and the range
 * its bits hold.
 *
 * @param {DepthFormat} format
 */
export function depthLayout(format){
    const named = format.greenMask >>> 0;
    const depthMask = named !== 0 ? named
        : format.bitCount >= 32 ? 0xffffffff : 2 ** Math.max(1, format.bitCount) - 1;
    const stencilMask = format.blueMask >>> 0;
    const depthShift = shiftOf(depthMask);
    const stencilShift = shiftOf(stencilMask);
    return {
        depthShift,
        depthRange: Math.floor(depthMask / 2 ** depthShift),
        stencilShift,
        stencilRange: Math.floor(stencilMask / 2 ** stencilShift),
    };
}

/**
 * Depths (and stencils) written into a depth buffer's bytes, in place. The
 * bits neither mask names are cleared; the padding past each row is left.
 *
 * @param {Uint8Array} bytes  the buffer's rows, `pitch` apart
 * @param {DepthPixels} pixels
 * @param {DepthFormat} format
 * @param {Float32Array} depths  0 to 1, one a pixel by rows
 * @param {Uint8Array | null} [stencils]
 */
export function packDepths(bytes, pixels, format, depths, stencils = null){
    const { depthShift, depthRange, stencilShift, stencilRange } = depthLayout(format);
    const { width, height, pitch, bytesPerPixel } = pixels;
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const index = y * width + x;
            const depth = Math.min(1, Math.max(0, depths[index] || 0));
            let value = Math.round(depth * depthRange) * 2 ** depthShift;
            if (stencils && stencilRange > 0)
            {
                value += (stencils[index] & stencilRange) * 2 ** stencilShift;
            }
            const at = y * pitch + x * bytesPerPixel;
            for (let byte = 0; byte < bytesPerPixel; byte++)
            {
                bytes[at + byte] = Math.floor(value / 2 ** (8 * byte)) & 0xff;
            }
        }
    }
}

/**
 * A depth buffer's bytes as depths 0 to 1, and stencils where the format
 * has them.
 *
 * @param {Uint8Array} bytes
 * @param {DepthPixels} pixels
 * @param {DepthFormat} format
 * @returns {{ depths: Float32Array, stencils: Uint8Array | null }}
 */
export function unpackDepths(bytes, pixels, format){
    const { depthShift, depthRange, stencilShift, stencilRange } = depthLayout(format);
    const { width, height, pitch, bytesPerPixel } = pixels;
    const depths = new Float32Array(width * height);
    const stencils = stencilRange > 0 ? new Uint8Array(width * height) : null;
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const at = y * pitch + x * bytesPerPixel;
            let value = 0;
            for (let byte = 0; byte < bytesPerPixel; byte++)
            {
                value += bytes[at + byte] * 2 ** (8 * byte);
            }
            const index = y * width + x;
            depths[index] = (Math.floor(value / 2 ** depthShift) % (depthRange + 1)) / depthRange;
            if (stencils)
            {
                stencils[index] = Math.floor(value / 2 ** stencilShift) % (stencilRange + 1);
            }
        }
    }
    return { depths, stencils };
}
