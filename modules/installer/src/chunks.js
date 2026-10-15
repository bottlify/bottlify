/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A file of an installation as the volume kept it: in pieces, read a block at
 * a time, never made whole. A game ships archive files of a gigabyte and more,
 * and gluing one into a single buffer -- to hand it to the page, to hash it --
 * was an allocation a tab could not make; the bottle was never saved.
 *
 * A file is `{ path, bytes }` -- whole, as an installer or an archive gives it
 * -- or `{ path, size, pieces }`: the volume's own pieces, the last cut short
 * by `size`, a missing one a run of zeros. `bytes` of the second kind is a
 * getter that makes it whole for a reader that wants it, a program's entry.
 */

/**
 * @typedef {Object} ChunkedFile
 * @property {string} path
 * @property {number} [size]
 * @property {(Uint8Array | null | undefined)[]} [pieces]
 * @property {{ size: number, flat: Uint8Array | null,
 *     pieces: (Uint8Array | undefined)[] }} [contents]  The volume's own, not enumerable.
 * @property {Uint8Array} bytes
 */

/**
 * A file's size, read without making it whole: from the pieces the worker
 * sent, the volume's own `contents` an engine on this thread hands out, or
 * the bytes of a file that came whole.
 *
 * @param {ChunkedFile} file
 */
export const sizeOf = file=>(file.pieces ? file.size ?? 0
    : file.contents ? file.contents.size : file.bytes.length);

/** @param {ChunkedFile} file @returns {(Uint8Array | null | undefined)[]} */
export const piecesOf = file=>file.pieces ?? (file.contents
    ? (file.contents.flat ? [file.contents.flat] : file.contents.pieces) : [file.bytes]);

/**
 * A file of pieces, its `bytes` made whole only when read.
 *
 * @param {string} path @param {number} size @param {(Uint8Array | null | undefined)[]} pieces
 * @returns {ChunkedFile}
 */
export function chunkedFile(path, size, pieces){
    /** @type {Uint8Array | null} */
    let whole = null;
    const file = /** @type {ChunkedFile} */ ({ path, size, pieces });
    Object.defineProperty(file, 'bytes', {
        enumerable: false,
        get: ()=>{
            if (!whole)
            {
                whole = new Uint8Array(size);
                let at = 0;
                for (const block of blocksOf(file, 1 << 20))
                {
                    whole.set(block, at);
                    at += block.length;
                }
            }
            return whole;
        },
    });
    return file;
}

/**
 * The same file under another path, its pieces not copied or joined.
 *
 * @param {ChunkedFile} file @param {string} path
 * @returns {ChunkedFile}
 */
export const atPath = (file, path)=>(file.pieces || file.contents
    ? chunkedFile(path, sizeOf(file), piecesOf(file)) : { path, bytes: file.bytes });

/**
 * A file's bytes in blocks of `blockSize`, the last shorter: views of its
 * pieces where a block lies in one, a block of its own where it spans two.
 * The pieces are all one length, but for the last.
 *
 * @param {ChunkedFile} file @param {number} blockSize
 * @returns {Generator<Uint8Array>}
 */
export function* blocksOf(file, blockSize){
    const size = sizeOf(file);
    const pieces = piecesOf(file);
    const unit = pieces.find(one=>one)?.length || size || 1;
    for (let at = 0; at < size; at += blockSize)
    {
        const length = Math.min(blockSize, size - at);
        const piece = pieces[Math.floor(at / unit)];
        const within = at % unit;
        if (piece && within + length <= piece.length)
        {
            yield piece.subarray(within, within + length);
            continue;
        }
        const block = new Uint8Array(length);
        for (let filled = 0; filled < length;)
        {
            const position = at + filled;
            const source = pieces[Math.floor(position / unit)];
            const from = position % unit;
            const take = Math.min(unit - from, length - filled);
            if (source)
            {
                block.set(source.subarray(from, Math.min(from + take, source.length)), filled);
            }
            filled += take;
        }
        yield block;
    }
}

/** SHA-256's round constants (FIPS 180-4, 4.2.2). */
const K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 over a file's blocks as they come (FIPS 180-4), as lowercase hex:
 * WebCrypto hashes only a buffer it is given whole.
 *
 * @param {Iterable<Uint8Array>} blocks
 * @returns {string}
 */
export function sha256Blocks(blocks){
    const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const chunk = new Uint8Array(64);
    let held = 0;
    let total = 0;
    /** @param {Uint8Array} data @param {number} at */
    const compress = (data, at)=>{
        for (let i = 0; i < 16; i++)
        {
            const o = at + i * 4;
            w[i] = (data[o] << 24 | data[o + 1] << 16 | data[o + 2] << 8 | data[o + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++)
        {
            const a = w[i - 15];
            const b = w[i - 2];
            const s0 = (a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ a >>> 3;
            const s1 = (b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ b >>> 10;
            w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
        }
        let a = h[0]; let b = h[1]; let c = h[2]; let d = h[3];
        let e = h[4]; let f = h[5]; let g = h[6]; let k = h[7];
        for (let i = 0; i < 64; i++)
        {
            const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
            const t1 = k + s1 + (e & f ^ ~e & g) + K[i] + w[i] >>> 0;
            const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
            const t2 = s0 + (a & b ^ a & c ^ b & c) >>> 0;
            k = g;
            g = f;
            f = e;
            e = d + t1 >>> 0;
            d = c;
            c = b;
            b = a;
            a = t1 + t2 >>> 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d;
        h[4] += e; h[5] += f; h[6] += g; h[7] += k;
    };
    for (const data of blocks)
    {
        total += data.length;
        let at = 0;
        if (held > 0)
        {
            const take = Math.min(64 - held, data.length);
            chunk.set(data.subarray(0, take), held);
            held += take;
            at = take;
            if (held === 64)
            {
                compress(chunk, 0);
                held = 0;
            }
        }
        for (; at + 64 <= data.length; at += 64)
        {
            compress(data, at);
        }
        if (at < data.length)
        {
            chunk.set(data.subarray(at), 0);
            held = data.length - at;
        }
    }
    chunk[held++] = 0x80;
    if (held > 56)
    {
        chunk.fill(0, held);
        compress(chunk, 0);
        held = 0;
    }
    chunk.fill(0, held, 56);
    const bits = total * 8;
    new DataView(chunk.buffer).setUint32(56, Math.floor(bits / 0x100000000));
    new DataView(chunk.buffer).setUint32(60, bits >>> 0);
    compress(chunk, 0);
    return Array.from(h, word=>word.toString(16).padStart(8, '0')).join('');
}
