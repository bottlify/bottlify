/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * S3TC/DXTn block decoding.
 *
 * The format is the same block of bits under OpenGL's S3TC extension and
 * Direct3D's DXTn surfaces: two RGB565 endpoints, 2-bit selectors per texel,
 * and DXT3's explicit or DXT5's interpolated alpha. Every drawing API that
 * decodes a kept-compressed texture for a device that cannot sample BC
 * blocks -- OpenGL always, Direct3D 8/9 when the adapter or the
 * configuration says no -- reads through here rather than each keeping its
 * own copy of the same arithmetic.
 */

/** @typedef {'dxt1' | 'dxt3' | 'dxt5'} S3tcKind */

/** @param {number} value @returns {number} a 5-bit field as a byte */
const from5 = value=>(value << 3) | (value >> 2);
/** @param {number} value @returns {number} a 6-bit field as a byte */
const from6 = value=>(value << 2) | (value >> 4);

/**
 * How many bytes an S3TC image of this shape takes: one block per 4x4, with
 * a partial block still a whole block.
 *
 * @param {S3tcKind} kind
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function compressedBytes(kind, width, height){
    const blocks = Math.ceil(width / 4) * Math.ceil(height / 4);
    return blocks * (kind === 'dxt1' ? 8 : 16);
}

/**
 * Decodes an S3TC image into RGBA texels.
 *
 * DXT1's punch-through mode (a block whose two endpoints sort so it has no
 * fourth interpolated colour) decodes index 3 as transparent black. A caller
 * whose surface has no alpha channel at all (OpenGL's `GL_RGB_S3TC_DXT1`)
 * conforms the result afterward, the way every other format's alpha is
 * conformed on upload -- decoding is the same either way.
 *
 * @param {Uint8Array} bytes
 * @param {S3tcKind} kind
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array | null} null when the bytes are too few for the shape
 */
export function decodeS3tc(bytes, kind, width, height){
    const needed = compressedBytes(kind, width, height);
    if (bytes.byteLength < needed)
    {
        return null;
    }
    const dxt1 = kind === 'dxt1';
    const blockBytes = dxt1 ? 8 : 16;
    const texels = new Uint8Array(width * height * 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blocksAcross = Math.ceil(width / 4);
    const blocksDown = Math.ceil(height / 4);
    const alpha = new Array(16).fill(255);
    for (let by = 0; by < blocksDown; by++)
    {
        for (let bx = 0; bx < blocksAcross; bx++)
        {
            const block = (by * blocksAcross + bx) * blockBytes;
            const colourAt = dxt1 ? block : block + 8;
            const c0 = view.getUint16(colourAt, true);
            const c1 = view.getUint16(colourAt + 2, true);
            const indices = view.getUint32(colourAt + 4, true);
            const rgb0 = [from5(c0 >> 11), from6((c0 >> 5) & 0x3f), from5(c0 & 0x1f)];
            const rgb1 = [from5(c1 >> 11), from6((c1 >> 5) & 0x3f), from5(c1 & 0x1f)];
            // Only DXT1 has the two-colour-plus-transparent mode; DXT3 and
            // DXT5 always interpolate four colours, whatever the order.
            const fourColours = !dxt1 || c0 > c1;
            const palette = [
                [...rgb0, 255],
                [...rgb1, 255],
                fourColours
                    ? [0, 1, 2].map(k=>Math.round((2 * rgb0[k] + rgb1[k]) / 3)).concat(255)
                    : [0, 1, 2].map(k=>Math.round((rgb0[k] + rgb1[k]) / 2)).concat(255),
                fourColours
                    ? [0, 1, 2].map(k=>Math.round((rgb0[k] + 2 * rgb1[k]) / 3)).concat(255)
                    : [0, 0, 0, 0],
            ];
            if (kind === 'dxt3')
            {
                for (let i = 0; i < 16; i++)
                {
                    const row = view.getUint16(block + (i >> 2) * 2, true);
                    alpha[i] = ((row >> ((i & 3) * 4)) & 0xf) * 17;
                }
            }
            else if (kind === 'dxt5')
            {
                const a0 = view.getUint8(block);
                const a1 = view.getUint8(block + 1);
                const table = a0 > a1
                    ? [a0, a1,
                        ...[6, 5, 4, 3, 2, 1].map(k=>Math.round((k * a0 + (7 - k) * a1) / 7))]
                    : [a0, a1, ...[4, 3, 2, 1].map(k=>Math.round((k * a0 + (5 - k) * a1) / 5)),
                        0, 255];
                // 48 bits of 3-bit indices, low bits first.
                for (let i = 0; i < 16; i++)
                {
                    const bit = i * 3;
                    const at = block + 2 + (bit >> 3);
                    const pair = view.getUint8(at) | (view.getUint8(at + 1) << 8);
                    alpha[i] = table[(pair >> (bit & 7)) & 7];
                }
            }
            for (let i = 0; i < 16; i++)
            {
                const x = bx * 4 + (i & 3);
                const y = by * 4 + (i >> 2);
                if (x >= width || y >= height)
                {
                    continue;
                }
                const colour = palette[(indices >>> (i * 2)) & 3];
                const at = (y * width + x) * 4;
                texels[at] = colour[0];
                texels[at + 1] = colour[1];
                texels[at + 2] = colour[2];
                texels[at + 3] = dxt1 ? colour[3] : alpha[i];
            }
        }
    }
    return texels;
}
