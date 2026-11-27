/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * S3TC (DXT1 to DXT5, BC1 to BC3) blocks, decoded and encoded.
 *
 * The same block of bits under OpenGL's S3TC extension, Direct3D 9's DXTn
 * surfaces and Direct3D 10's BC1 to BC3: two RGB565 endpoints, 2-bit
 * selectors per texel, and DXT3's explicit or DXT5's interpolated alpha. Every
 * API that decodes a block for a device that cannot sample one, and D3DX's
 * loaders, read and write through here, so a block means one picture wherever
 * it goes. It lives in media because both the drawing layers and win32's D3DX
 * reach media, and neither reaches the other's internals.
 *
 * Colours are worked as the specification states them: an endpoint is a
 * normalised value (a 5-bit field over 31, a 6-bit one over 63), the blended
 * entries are thirds or the half of those values, and the result is the
 * nearest byte. Bit replication of the endpoints and blending their bytes are
 * both within the hardware tolerance but are off that by one in about one
 * byte in ten; computed from the fields, every entry is the exact answer.
 *
 * Texels are RGBA, four bytes each.
 */

/** @typedef {'dxt1' | 'dxt3' | 'dxt5'} S3tcKind */

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
 * A block's four RGBA colours into `palette` (sixteen bytes). DXT1 with
 * `c0 <= c1` has three colours and transparent black; DXT3 and DXT5 always
 * interpolate four, whatever the order (`four`).
 *
 * @param {number} c0 @param {number} c1 @param {boolean} four
 * @param {Uint8Array} palette
 */
function colours(c0, c1, four, palette){
    for (let channel = 0; channel < 3; channel++)
    {
        const shift = channel === 0 ? 11 : channel === 1 ? 5 : 0;
        const max = channel === 1 ? 63 : 31;
        const v0 = (c0 >> shift) & max;
        const v1 = (c1 >> shift) & max;
        palette[channel] = Math.round(v0 * 255 / max);
        palette[4 + channel] = Math.round(v1 * 255 / max);
        if (four)
        {
            palette[8 + channel] = Math.round((2 * v0 + v1) * 255 / (3 * max));
            palette[12 + channel] = Math.round((v0 + 2 * v1) * 255 / (3 * max));
        }
        else
        {
            palette[8 + channel] = Math.round((v0 + v1) * 255 / (2 * max));
            palette[12 + channel] = 0;
        }
    }
    palette[3] = palette[7] = palette[11] = 255;
    palette[15] = four ? 255 : 0;
}

/**
 * The eight values an interpolated block's ends stand for (DXT5's alpha, each
 * channel of BC4 and BC5): ends in falling order give six steps between them,
 * otherwise four and then the range's two extremes, `low` and `high`.
 *
 * @param {number} e0 @param {number} e1 @param {number} low @param {number} high
 * @param {number[] | Int16Array | Uint8Array} into  eight entries
 */
export function alphaLevels(e0, e1, low, high, into){
    into[0] = e0;
    into[1] = e1;
    if (e0 > e1)
    {
        for (let k = 1; k < 7; k++)
        {
            into[1 + k] = Math.round(((7 - k) * e0 + k * e1) / 7);
        }
        return;
    }
    for (let k = 1; k < 5; k++)
    {
        into[1 + k] = Math.round(((5 - k) * e0 + k * e1) / 5);
    }
    into[6] = low;
    into[7] = high;
}

/**
 * The sixteen values of an eight-byte interpolated block of unsigned ends.
 *
 * @param {Uint8Array} data @param {number} at
 * @param {number[] | Uint8Array} [into]  sixteen entries
 * @returns {number[] | Uint8Array}
 */
export function decodeAlphaBlock(data, at, into = new Array(16)){
    const levels = [0, 0, 0, 0, 0, 0, 0, 0];
    alphaLevels(data[at], data[at + 1], 0, 255, levels);
    // Forty-eight bits of 3-bit indices, low first: two halves of eight each.
    const low = data[at + 2] | data[at + 3] << 8 | data[at + 4] << 16;
    const high = data[at + 5] | data[at + 6] << 8 | data[at + 7] << 16;
    for (let k = 0; k < 16; k++)
    {
        into[k] = levels[(k < 8 ? low >> (k * 3) : high >> ((k - 8) * 3)) & 7];
    }
    return into;
}

/**
 * Sixteen values into such a block: the largest and smallest as its ends,
 * each value the nearest of the eight steps.
 *
 * @param {ArrayLike<number>} values @param {Uint8Array} out @param {number} at
 */
export function encodeAlphaBlock(values, out, at){
    let a0 = 0;
    let a1 = 255;
    for (let k = 0; k < 16; k++)
    {
        a0 = Math.max(a0, values[k]);
        a1 = Math.min(a1, values[k]);
    }
    const levels = [0, 0, 0, 0, 0, 0, 0, 0];
    alphaLevels(a0, a1, 0, 255, levels);
    // One value is its own end: every index stays 0.
    const steps = a0 === a1 ? 1 : 8;
    let low = 0;
    let high = 0;
    for (let k = 0; k < 16; k++)
    {
        let best = 0;
        for (let i = 1; i < steps; i++)
        {
            if (Math.abs(levels[i] - values[k]) < Math.abs(levels[best] - values[k]))
            {
                best = i;
            }
        }
        if (k < 8)
        {
            low |= best << (k * 3);
        }
        else
        {
            high |= best << ((k - 8) * 3);
        }
    }
    out[at] = a0;
    out[at + 1] = a1;
    for (let k = 0; k < 3; k++)
    {
        out[at + 2 + k] = (low >> (k * 8)) & 0xff;
        out[at + 5 + k] = (high >> (k * 8)) & 0xff;
    }
}

/**
 * Decodes an S3TC image into RGBA texels.
 *
 * DXT1's three-colour mode decodes index 3 as transparent black. A caller
 * whose surface has no alpha channel at all (OpenGL's `GL_RGB_S3TC_DXT1`)
 * conforms the result afterward, the way every other format's alpha is
 * conformed on upload - decoding is the same either way.
 *
 * A block's palette and alphas are worked in small arrays made once per
 * call, not per block: a texture of a few hundred texels square is thousands
 * of blocks. `into`, when it is large enough, receives the texels instead of
 * an array made for them - for a caller that hands them on at once and
 * decodes the next level into the same bytes.
 *
 * @param {Uint8Array} bytes
 * @param {S3tcKind} kind
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} [into]
 * @returns {Uint8Array | null} null when the bytes are too few for the shape
 */
export function decodeS3tc(bytes, kind, width, height, into){
    if (bytes.byteLength < compressedBytes(kind, width, height))
    {
        return null;
    }
    const dxt1 = kind === 'dxt1';
    const blockBytes = dxt1 ? 8 : 16;
    const length = width * height * 4;
    const texels = into !== undefined && into.length >= length
        ? into.subarray(0, length)
        : new Uint8Array(length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blocksAcross = Math.ceil(width / 4);
    const blocksDown = Math.ceil(height / 4);
    const palette = new Uint8Array(16);
    const alpha = new Uint8Array(16);
    for (let by = 0; by < blocksDown; by++)
    {
        for (let bx = 0; bx < blocksAcross; bx++)
        {
            const block = (by * blocksAcross + bx) * blockBytes;
            const colourAt = dxt1 ? block : block + 8;
            const c0 = view.getUint16(colourAt, true);
            const c1 = view.getUint16(colourAt + 2, true);
            const indices = view.getUint32(colourAt + 4, true);
            colours(c0, c1, !dxt1 || c0 > c1, palette);
            if (kind === 'dxt3')
            {
                for (let i = 0; i < 16; i++)
                {
                    alpha[i] = ((bytes[block + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17;
                }
            }
            else if (kind === 'dxt5')
            {
                decodeAlphaBlock(bytes, block, alpha);
            }
            for (let i = 0; i < 16; i++)
            {
                const x = bx * 4 + (i & 3);
                const y = by * 4 + (i >> 2);
                if (x >= width || y >= height)
                {
                    continue;
                }
                const colour = ((indices >>> (i * 2)) & 3) * 4;
                const at = (y * width + x) * 4;
                texels[at] = palette[colour];
                texels[at + 1] = palette[colour + 1];
                texels[at + 2] = palette[colour + 2];
                texels[at + 3] = dxt1 ? palette[colour + 3] : alpha[i];
            }
        }
    }
    return texels;
}

/** @param {number} byte @param {number} bits @returns {number} the nearest field of `bits` */
const fieldOfByte = (byte, bits)=>Math.round(byte * ((1 << bits) - 1) / 255);

/**
 * Encodes RGBA texels into S3TC blocks with a range fit: a block's colours
 * placed between its two most distant ones, each texel the nearest of the
 * colours the block decodes to. A block that is one colour decodes back to
 * that colour as far as RGB565 holds it; DXT1 keeps a texel under half alpha
 * transparent. `blocks`, when given, are the only ones written into `into`
 * (the rest keep their bytes): a copy into part of a surface leaves the
 * blocks it does not touch as they were rather than re-encoded.
 *
 * @param {Uint8Array} texels  width x height RGBA
 * @param {S3tcKind} kind
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} into  compressedBytes(kind, width, height) bytes
 * @param {{ left: number, top: number, right: number, bottom: number }} [blocks]
 *        in blocks, right and bottom exclusive
 */
export function encodeS3tc(texels, kind, width, height, into, blocks){
    const dxt1 = kind === 'dxt1';
    const blockBytes = dxt1 ? 8 : 16;
    const across = Math.ceil(width / 4);
    const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
    const area = blocks ?? { left: 0, top: 0, right: across, bottom: Math.ceil(height / 4) };
    /** @type {number[][]} */
    const block = Array.from({ length: 16 }, ()=>[0, 0, 0, 0]);
    const palette = new Uint8Array(16);
    const alphas = new Uint8Array(16);
    /** @param {number[]} p @returns {number} */
    const to565 = p=>fieldOfByte(p[0], 5) << 11 | fieldOfByte(p[1], 6) << 5 | fieldOfByte(p[2], 5);
    for (let by = area.top; by < area.bottom; by++)
    {
        for (let bx = area.left; bx < area.right; bx++)
        {
            for (let k = 0; k < 16; k++)
            {
                const x = Math.min(width - 1, bx * 4 + (k & 3));
                const y = Math.min(height - 1, by * 4 + (k >> 2));
                const at = (y * width + x) * 4;
                const texel = block[k];
                texel[0] = texels[at];
                texel[1] = texels[at + 1];
                texel[2] = texels[at + 2];
                texel[3] = alphas[k] = texels[at + 3];
            }
            const start = (by * across + bx) * blockBytes;
            into.fill(0, start, start + blockBytes);
            const punch = dxt1 && block.some(t=>t[3] < 128);
            const lit = block.filter(t=>!punch || t[3] >= 128);
            // The two farthest apart: a bounding box's corners miss colours
            // whose channels run against each other.
            const none = [0, 0, 0];
            let ends = [lit[0] ?? none, lit[0] ?? none];
            let spread = -1;
            for (const p of lit)
            {
                for (const q of lit)
                {
                    const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
                    if (d > spread)
                    {
                        spread = d;
                        ends = [p, q];
                    }
                }
            }
            let c0 = to565(ends[0]);
            let c1 = to565(ends[1]);
            // Four colours want c0 > c1; three and transparent want c0 <= c1.
            if (punch ? c0 > c1 : c0 < c1)
            {
                [c0, c1] = [c1, c0];
            }
            const four = !dxt1 || c0 > c1;
            colours(c0, c1, four, palette);
            // Three-colour mode's fourth entry is transparent: only a hole takes it.
            const choices = four ? 4 : 3;
            let indices = 0;
            for (let k = 0; k < 16; k++)
            {
                const t = block[k];
                let best = 3;
                if (!punch || t[3] >= 128)
                {
                    let error = Infinity;
                    for (let i = 0; i < choices; i++)
                    {
                        const e = (palette[i * 4] - t[0]) ** 2 + (palette[i * 4 + 1] - t[1]) ** 2
                            + (palette[i * 4 + 2] - t[2]) ** 2;
                        if (e < error)
                        {
                            error = e;
                            best = i;
                        }
                    }
                }
                indices |= best << (k * 2);
            }
            const colourAt = dxt1 ? start : start + 8;
            view.setUint16(colourAt, c0, true);
            view.setUint16(colourAt + 2, c1, true);
            view.setUint32(colourAt + 4, indices >>> 0, true);
            if (kind === 'dxt3')
            {
                for (let k = 0; k < 16; k++)
                {
                    into[start + (k >> 1)] |= fieldOfByte(alphas[k], 4) << ((k & 1) * 4);
                }
            }
            else if (kind === 'dxt5')
            {
                encodeAlphaBlock(alphas, into, start);
            }
        }
    }
}
