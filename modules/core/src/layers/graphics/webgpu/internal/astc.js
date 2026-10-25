/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * S3TC's DXT1 blocks as ASTC 4x4 blocks, for a device that samples ASTC and
 * not BC: what a phone's GPU has. Decoded instead, a DXT1 texel is four bytes
 * on the GPU for half a byte in the block; as ASTC it is one.
 *
 * A DXT1 block is two RGB565 endpoints and a 2-bit index per texel. With its
 * first endpoint the greater, the indices pick the endpoints and the points a
 * third and two thirds of the way between them: one line of colour with four
 * stops. ASTC (Khronos' KHR_texture_compression_astc_ldr, its block layout
 * in section C.2) says the same with one partition, endpoint mode 8 (RGB
 * direct, the endpoints at 8 bits, which 79 bits of room hold) and a 4x4 grid
 * of weights in 0..3, which unquantize to 0, 21, 43 and 64 sixty-fourths: the
 * thirds within a 64th, so a texel decodes within a step or two of the DXT1
 * decoder's. With the first endpoint the lesser, a block has three stops,
 * the endpoints and their midpoint -- weights in 0..2, as trits, 0, 32 and 64
 * -- and a fourth index that is black, or transparent: no point of the line.
 * A texture with such a texel anywhere is not transcoded (null), and is
 * decoded as before.
 *
 * No search: each block is rewritten from its own bits.
 */

/** @param {number} value @returns {number} a 5-bit field as a byte */
const from5 = value=>(value << 3) | (value >> 2);
/** @param {number} value @returns {number} a 6-bit field as a byte */
const from6 = value=>(value << 2) | (value >> 4);

/**
 * The block mode field (C.2.10, the first row of table C.2.8): a 4x4 weight
 * grid (B 0, A 2), one plane, low precision, and R the weight range --
 * 0b100 for 0..3, 0b011 for 0..2. Bits 1 and 0 are R2 and R1, bit 4 is R0.
 *
 * @param {number} range  R
 * @returns {number}
 */
const blockMode = range=>(2 << 5) | ((range & 1) << 4) | ((range >> 2) << 1) | ((range >> 1) & 1);

/** One partition (bits 12:11 zero) and endpoint mode 8 in bits 16:13. */
const HEADER_FOUR = blockMode(0b100) | (8 << 13);
const HEADER_THREE = blockMode(0b011) | (8 << 13);

/**
 * Each five trits' packed byte (C.2.12): the least byte the decoding takes
 * to them, indexed by t0 + 3 t1 + 9 t2 + 27 t3 + 81 t4. The least, so that a
 * group cut short by the stream's end -- the weights' last group here holds
 * one trit in two bits -- reads the trits after it as zero.
 */
const TRIT_BYTES = (()=>{
    const bytes = new Uint8Array(243).fill(0xff);
    for (let packed = 255; packed >= 0; packed--)
    {
        const bit = (/** @type {number} */ at, /** @type {number} */ count = 1)=>
            (packed >> at) & ((1 << count) - 1);
        let c;
        let t3;
        let t4;
        if (bit(2, 3) === 0b111)
        {
            c = (bit(5, 3) << 2) | bit(0, 2);
            t4 = 2;
            t3 = 2;
        }
        else
        {
            c = bit(0, 5);
            if (bit(5, 2) === 0b11)
            {
                t4 = 2;
                t3 = bit(7);
            }
            else
            {
                t4 = bit(7);
                t3 = bit(5, 2);
            }
        }
        let t0;
        let t1;
        let t2;
        if ((c & 3) === 3)
        {
            t2 = 2;
            t1 = c >> 4;
            t0 = (((c >> 3) & 1) << 1) | (((c >> 2) & 1) & ~(c >> 3) & 1);
        }
        else if (((c >> 2) & 3) === 3)
        {
            t2 = 2;
            t1 = 2;
            t0 = c & 3;
        }
        else
        {
            t2 = c >> 4;
            t1 = (c >> 2) & 3;
            t0 = (((c >> 1) & 1) << 1) | ((c & 1) & ~(c >> 1) & 1);
        }
        bytes[t0 + 3 * t1 + 9 * t2 + 27 * t3 + 81 * t4] = packed;
    }
    return bytes;
})();

/** @param {number} word @returns {number} its 32 bits in reverse order */
const reversed = word=>{
    let bits = word >>> 0;
    bits = ((bits >>> 1) & 0x55555555) | ((bits & 0x55555555) << 1);
    bits = ((bits >>> 2) & 0x33333333) | ((bits & 0x33333333) << 2);
    bits = ((bits >>> 4) & 0x0f0f0f0f) | ((bits & 0x0f0f0f0f) << 4);
    bits = ((bits >>> 8) & 0x00ff00ff) | ((bits & 0x00ff00ff) << 8);
    return ((bits >>> 16) | (bits << 16)) >>> 0;
};

/**
 * Whether a DXT1 image transcodes: whether none of its three-stop blocks
 * has a texel of the fourth colour. Read without transcoding, for a caller
 * that settles a texture's format before it uploads anything.
 *
 * @param {Uint8Array} bytes
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
export function dxt1Transcodes(bytes, width, height){
    const blocks = Math.ceil(width / 4) * Math.ceil(height / 4);
    if (bytes.byteLength < blocks * 8)
    {
        return false;
    }
    const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let block = 0; block < blocks; block++)
    {
        if (source.getUint16(block * 8, true) > source.getUint16(block * 8 + 2, true))
        {
            continue;
        }
        const indices = source.getUint32(block * 8 + 4, true);
        // A texel's two bits both set: index 3.
        if ((indices & (indices >>> 1) & 0x55555555) !== 0)
        {
            return false;
        }
    }
    return true;
}

/**
 * A DXT1 image as ASTC 4x4 blocks, one for each of its blocks in the same
 * order, or null where a block has a texel of its fourth, black or
 * transparent, colour.
 *
 * @param {Uint8Array} bytes
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array | null}
 */
export function dxt1ToAstc(bytes, width, height){
    const blocks = Math.ceil(width / 4) * Math.ceil(height / 4);
    if (bytes.byteLength < blocks * 8)
    {
        return null;
    }
    const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Uint8Array(blocks * 16);
    const into = new DataView(out.buffer);
    for (let block = 0; block < blocks; block++)
    {
        const first = source.getUint16(block * 8, true);
        const second = source.getUint16(block * 8 + 2, true);
        const indices = source.getUint32(block * 8 + 4, true);
        let r0 = from5(first >> 11);
        let g0 = from6((first >> 5) & 0x3f);
        let b0 = from5(first & 0x1f);
        let r1 = from5(second >> 11);
        let g1 = from6((second >> 5) & 0x3f);
        let b1 = from5(second & 0x1f);
        // Mode 8 reads endpoints whose second sums less than the first as
        // blue-contracted and swapped: they are written the other way round,
        // and the weights mirrored with them.
        const swap = r1 + g1 + b1 < r0 + g0 + b0;
        if (swap)
        {
            [r0, r1, g0, g1, b0, b1] = [r1, r0, g1, g0, b1, b0];
        }
        let header;
        let weights;
        if (first > second)
        {
            header = HEADER_FOUR;
            // Index 0, 1, 2, 3 -> weight 0, 3, 1, 2 of 0..3; two bits each.
            weights = 0;
            for (let texel = 0; texel < 16; texel++)
            {
                const index = (indices >>> (texel * 2)) & 3;
                let weight = index === 0 ? 0 : index === 1 ? 3 : index - 1;
                if (swap)
                {
                    weight = 3 - weight;
                }
                weights |= weight << (texel * 2);
            }
        }
        else
        {
            header = HEADER_THREE;
            // Index 0, 1, 2 -> weight 0, 2, 1 of 0..2; five trits a byte,
            // the last byte cut to two bits by the stream's 26.
            weights = 0;
            let group = 0;
            let scale = 1;
            for (let texel = 0; texel < 16; texel++)
            {
                const index = (indices >>> (texel * 2)) & 3;
                if (index === 3)
                {
                    return null;
                }
                let weight = index === 0 ? 0 : index === 1 ? 2 : 1;
                if (swap)
                {
                    weight = 2 - weight;
                }
                group += weight * scale;
                scale *= 3;
                if (texel % 5 === 4 || texel === 15)
                {
                    weights |= TRIT_BYTES[group] << (8 * Math.floor(texel / 5));
                    group = 0;
                    scale = 1;
                }
            }
        }
        // Bits 0..16 the header, 17.. the endpoints r0 r1 g0 g1 b0 b1 a byte
        // each, and the weights' stream from bit 127 down: stream bit n is
        // block bit 127 - n, so the last word is the stream reversed.
        const values = [r0, r1, g0, g1, b0, b1];
        const words = [header, 0, 0, reversed(weights)];
        values.forEach((value, at)=>{
            const bit = 17 + at * 8;
            words[bit >>> 5] |= value << (bit & 31);
            if ((bit & 31) > 24)
            {
                words[(bit >>> 5) + 1] |= value >>> (32 - (bit & 31));
            }
        });
        for (let word = 0; word < 4; word++)
        {
            into.setUint32(block * 16 + word * 4, words[word] >>> 0, true);
        }
    }
    return out;
}
