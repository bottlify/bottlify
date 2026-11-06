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
 * A block's palette and alphas are worked in small arrays made once per
 * call, not per block: a texture of a few hundred texels square is thousands
 * of blocks, and arrays made for each are garbage by the thousand. `into`,
 * when it is large enough, receives the texels instead of an array made for
 * them -- for a caller that hands them on at once and decodes the next level
 * into the same bytes.
 *
 * @param {Uint8Array} bytes
 * @param {S3tcKind} kind
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} [into]
 * @returns {Uint8Array | null} null when the bytes are too few for the shape
 */
export function decodeS3tc(bytes, kind, width, height, into){
    const needed = compressedBytes(kind, width, height);
    if (bytes.byteLength < needed)
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
    // Four RGBA entries, and the eight values DXT5's indices pick from.
    const palette = new Uint8Array(16);
    const table = new Uint8Array(8);
    const alpha = new Uint8Array(16).fill(255);
    for (let by = 0; by < blocksDown; by++)
    {
        for (let bx = 0; bx < blocksAcross; bx++)
        {
            const block = (by * blocksAcross + bx) * blockBytes;
            const colourAt = dxt1 ? block : block + 8;
            const c0 = view.getUint16(colourAt, true);
            const c1 = view.getUint16(colourAt + 2, true);
            const indices = view.getUint32(colourAt + 4, true);
            const r0 = from5(c0 >> 11), g0 = from6((c0 >> 5) & 0x3f), b0 = from5(c0 & 0x1f);
            const r1 = from5(c1 >> 11), g1 = from6((c1 >> 5) & 0x3f), b1 = from5(c1 & 0x1f);
            palette[0] = r0; palette[1] = g0; palette[2] = b0; palette[3] = 255;
            palette[4] = r1; palette[5] = g1; palette[6] = b1; palette[7] = 255;
            // Only DXT1 has the two-colour-plus-transparent mode; DXT3 and
            // DXT5 always interpolate four colours, whatever the order.
            if (!dxt1 || c0 > c1)
            {
                palette[8] = Math.round((2 * r0 + r1) / 3);
                palette[9] = Math.round((2 * g0 + g1) / 3);
                palette[10] = Math.round((2 * b0 + b1) / 3);
                palette[11] = 255;
                palette[12] = Math.round((r0 + 2 * r1) / 3);
                palette[13] = Math.round((g0 + 2 * g1) / 3);
                palette[14] = Math.round((b0 + 2 * b1) / 3);
                palette[15] = 255;
            }
            else
            {
                palette[8] = Math.round((r0 + r1) / 2);
                palette[9] = Math.round((g0 + g1) / 2);
                palette[10] = Math.round((b0 + b1) / 2);
                palette[11] = 255;
                palette[12] = 0; palette[13] = 0; palette[14] = 0; palette[15] = 0;
            }
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
                table[0] = a0;
                table[1] = a1;
                if (a0 > a1)
                {
                    for (let k = 6; k >= 1; k--)
                    {
                        table[8 - k] = Math.round((k * a0 + (7 - k) * a1) / 7);
                    }
                }
                else
                {
                    for (let k = 4; k >= 1; k--)
                    {
                        table[6 - k] = Math.round((k * a0 + (5 - k) * a1) / 5);
                    }
                    table[6] = 0;
                    table[7] = 255;
                }
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
 * placed between its two most distant ones. A block that is one colour
 * decodes back to that colour as far as RGB565 holds it. `blocks`, when
 * given, are the only ones written into `into` (the rest keep their bytes):
 * a copy into part of a surface leaves the blocks it does not touch as they
 * were rather than re-encoded. Direct3DX's loader keeps an encoder of its own
 * (win32/d3dx9/pixels.js) on the far side of the module boundary.
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
    /** @param {number[]} p @returns {number} */
    const to565 = p=>fieldOfByte(p[0], 5) << 11 | fieldOfByte(p[1], 6) << 5 | fieldOfByte(p[2], 5);
    /** @param {number} c @returns {number[]} */
    const from565 = c=>[from5(c >> 11), from6((c >> 5) & 0x3f), from5(c & 0x1f)];
    for (let by = area.top; by < area.bottom; by++)
    {
        for (let bx = area.left; bx < area.right; bx++)
        {
            for (let k = 0; k < 16; k++)
            {
                const x = Math.min(width - 1, bx * 4 + (k & 3));
                const y = Math.min(height - 1, by * 4 + (k >> 2));
                const at = (y * width + x) * 4;
                block[k] = [texels[at], texels[at + 1], texels[at + 2], texels[at + 3]];
            }
            const start = (by * across + bx) * blockBytes;
            into.fill(0, start, start + blockBytes);
            const punch = dxt1 && block.some(t=>t[3] < 128);
            const lit = block.filter(t=>!punch || t[3] >= 128);
            let ends = [lit[0] ?? [0, 0, 0], lit[0] ?? [0, 0, 0]];
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
            const p0 = from565(c0);
            const p1 = from565(c1);
            const palette = punch || c0 <= c1
                ? [p0, p1, [0, 1, 2].map(i=>(p0[i] + p1[i]) / 2)]
                : [p0, p1, [0, 1, 2].map(i=>(2 * p0[i] + p1[i]) / 3),
                    [0, 1, 2].map(i=>(p0[i] + 2 * p1[i]) / 3)];
            let indices = 0;
            block.forEach((t, k)=>{
                let best = 3;
                if (!punch || t[3] >= 128)
                {
                    let error = Infinity;
                    palette.forEach((p, i)=>{
                        const e = (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2;
                        if (e < error)
                        {
                            error = e;
                            best = i;
                        }
                    });
                }
                indices |= best << (k * 2);
            });
            const colourAt = dxt1 ? start : start + 8;
            view.setUint16(colourAt, c0, true);
            view.setUint16(colourAt + 2, c1, true);
            view.setUint32(colourAt + 4, indices >>> 0, true);
            if (kind === 'dxt3')
            {
                block.forEach((t, k)=>{
                    into[start + (k >> 1)] |= fieldOfByte(t[3], 4) << ((k & 1) * 4);
                });
            }
            else if (kind === 'dxt5')
            {
                const a0 = Math.max(...block.map(t=>t[3]));
                const a1 = Math.min(...block.map(t=>t[3]));
                into[start] = a0;
                into[start + 1] = a1;
                const levels = [a0, a1];
                for (let k = 1; k < 7; k++)
                {
                    levels.push(((7 - k) * a0 + k * a1) / 7);
                }
                let low = 0;
                let high = 0;
                block.forEach((t, k)=>{
                    let best = 0;
                    if (a0 !== a1)
                    {
                        levels.forEach((level, i)=>{
                            if (Math.abs(level - t[3]) < Math.abs(levels[best] - t[3]))
                            {
                                best = i;
                            }
                        });
                    }
                    const bit = k * 3;
                    // Eight indices fill 24 bits exactly: none straddles the halves.
                    if (bit < 24)
                    {
                        low |= best << bit;
                    }
                    else
                    {
                        high |= best << (bit - 24);
                    }
                });
                for (let k = 0; k < 3; k++)
                {
                    into[start + 2 + k] = (low >> (k * 8)) & 0xff;
                    into[start + 5 + k] = (high >> (k * 8)) & 0xff;
                }
            }
        }
    }
}
