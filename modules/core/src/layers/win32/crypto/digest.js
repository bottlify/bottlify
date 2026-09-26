/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MD5, SHA-1 and SHA-256 as streaming digests, written out against their
 * published definitions (RFC 1321, FIPS 180). They run synchronously, because a
 * call into the guest cannot await Web Crypto, and they are shared by every
 * library that hashes: the CryptoAPI provider and the Authenticode verifier.
 */

/* ------------------------------------------------------------------ *
 * Byte-order helpers: MD5 reads and writes its words little-endian,
 * SHA-1 and SHA-256 big-endian.
 * ------------------------------------------------------------------ */

/** @param {Uint8Array} b @param {number} o */
const readU32LE = (b, o)=>((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
    | (b[o + 3] << 24)) >>> 0);

/** @param {Uint8Array} b @param {number} o */
const readU32BE = (b, o)=>(((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8)
    | b[o + 3]) >>> 0);

/** @param {Uint8Array} b @param {number} o @param {number} v */
const writeU32LE = (b, o, v)=>{
    b[o] = v & 0xff;
    b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff;
    b[o + 3] = (v >>> 24) & 0xff;
};

/** @param {Uint8Array} b @param {number} o @param {number} v */
const writeU32BE = (b, o, v)=>{
    b[o] = (v >>> 24) & 0xff;
    b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff;
    b[o + 3] = v & 0xff;
};

/** @param {number} x @param {number} s */
const rotl = (x, s)=>(((x << s) | (x >>> (32 - s))) >>> 0);

/** @param {number} x @param {number} s */
const rotr = (x, s)=>(((x >>> s) | (x << (32 - s))) >>> 0);

/* ------------------------------------------------------------------ *
 * Block-hash engine: MD5, SHA-1 and SHA-256 all compress fixed-size
 * blocks over a word state and differ only in the compression, the
 * endianness of the length field and of the output words.
 * ------------------------------------------------------------------ */

/**
 * A streaming digest.
 *
 * @typedef {Object} Digest
 * @property {(bytes: Uint8Array) => void} update
 * @property {() => Uint8Array} digest
 * @property {() => Digest} clone
 */

/**
 * @typedef {Object} BlockHashConfig
 * @property {number} blockSize
 * @property {number[]} initial
 * @property {(state: Uint32Array, bytes: Uint8Array, offset: number) => void} compress
 * @property {boolean} littleEndian length field and output word order
 */

/** The MD5 round shifts, in the order the four rounds use them. */
const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** The MD5 sine table, computed rather than transcribed: K[i] = |sin(i+1)| * 2^32. */
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++)
{
    MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

/** @param {Uint32Array} st @param {Uint8Array} b @param {number} o */
function md5Compress(st, b, o){
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++)
    {
        M[i] = readU32LE(b, o + i * 4);
    }
    let a = st[0];
    let bb = st[1];
    let c = st[2];
    let d = st[3];
    for (let i = 0; i < 64; i++)
    {
        let f;
        let g;
        if (i < 16)
        {
            f = ((bb & c) | (~bb & d)) >>> 0;
            g = i;
        }
        else if (i < 32)
        {
            f = ((d & bb) | (~d & c)) >>> 0;
            g = (5 * i + 1) % 16;
        }
        else if (i < 48)
        {
            f = (bb ^ c ^ d) >>> 0;
            g = (3 * i + 5) % 16;
        }
        else
        {
            f = (c ^ (bb | (~d))) >>> 0;
            g = (7 * i) % 16;
        }
        const sum = (f + a + MD5_K[i] + M[g]) >>> 0;
        a = d;
        d = c;
        c = bb;
        bb = (bb + rotl(sum, MD5_S[i])) >>> 0;
    }
    st[0] = (st[0] + a) >>> 0;
    st[1] = (st[1] + bb) >>> 0;
    st[2] = (st[2] + c) >>> 0;
    st[3] = (st[3] + d) >>> 0;
}

/** @param {Uint32Array} st @param {Uint8Array} b @param {number} o */
function sha1Compress(st, b, o){
    const W = new Uint32Array(80);
    for (let i = 0; i < 16; i++)
    {
        W[i] = readU32BE(b, o + i * 4);
    }
    for (let i = 16; i < 80; i++)
    {
        W[i] = rotl((W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]) >>> 0, 1);
    }
    let a = st[0];
    let bb = st[1];
    let c = st[2];
    let d = st[3];
    let e = st[4];
    for (let i = 0; i < 80; i++)
    {
        let f;
        let k;
        if (i < 20)
        {
            f = ((bb & c) | (~bb & d)) >>> 0;
            k = 0x5a827999;
        }
        else if (i < 40)
        {
            f = (bb ^ c ^ d) >>> 0;
            k = 0x6ed9eba1;
        }
        else if (i < 60)
        {
            f = ((bb & c) | (bb & d) | (c & d)) >>> 0;
            k = 0x8f1bbcdc;
        }
        else
        {
            f = (bb ^ c ^ d) >>> 0;
            k = 0xca62c1d6;
        }
        const temp = (rotl(a, 5) + f + e + k + W[i]) >>> 0;
        e = d;
        d = c;
        c = rotl(bb, 30);
        bb = a;
        a = temp;
    }
    st[0] = (st[0] + a) >>> 0;
    st[1] = (st[1] + bb) >>> 0;
    st[2] = (st[2] + c) >>> 0;
    st[3] = (st[3] + d) >>> 0;
    st[4] = (st[4] + e) >>> 0;
}

/** The SHA-256 round constants: the first 32 bits of the cube roots of primes. */
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @param {Uint32Array} st @param {Uint8Array} b @param {number} o */
function sha256Compress(st, b, o){
    const W = new Uint32Array(64);
    for (let i = 0; i < 16; i++)
    {
        W[i] = readU32BE(b, o + i * 4);
    }
    for (let i = 16; i < 64; i++)
    {
        const s0 = (rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)) >>> 0;
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = st[0];
    let bb = st[1];
    let c = st[2];
    let d = st[3];
    let e = st[4];
    let f = st[5];
    let g = st[6];
    let h = st[7];
    for (let i = 0; i < 64; i++)
    {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + s1 + ch + SHA256_K[i] + W[i]) >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
        const t2 = (s0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = bb;
        bb = a;
        a = (t1 + t2) >>> 0;
    }
    st[0] = (st[0] + a) >>> 0;
    st[1] = (st[1] + bb) >>> 0;
    st[2] = (st[2] + c) >>> 0;
    st[3] = (st[3] + d) >>> 0;
    st[4] = (st[4] + e) >>> 0;
    st[5] = (st[5] + f) >>> 0;
    st[6] = (st[6] + g) >>> 0;
    st[7] = (st[7] + h) >>> 0;
}

/** @type {BlockHashConfig} */
const MD5_CONFIG = {
    blockSize: 64,
    initial: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476],
    compress: md5Compress,
    littleEndian: true,
};

/** @type {BlockHashConfig} */
const SHA1_CONFIG = {
    blockSize: 64,
    initial: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0],
    compress: sha1Compress,
    littleEndian: false,
};

/** @type {BlockHashConfig} */
const SHA256_CONFIG = {
    blockSize: 64,
    initial: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
    compress: sha256Compress,
    littleEndian: false,
};

/**
 * @typedef {Object} HashSnapshot
 * @property {Uint32Array} state
 * @property {Uint8Array} block
 * @property {number} blockLen
 * @property {number} total
 */

/**
 * Builds a streaming digest over a block compression.
 *
 * @param {BlockHashConfig} config
 * @param {HashSnapshot} [snapshot] prior state, when cloning
 * @returns {Digest}
 */
function createBlockHash(config, snapshot){
    const state = snapshot ? Uint32Array.from(snapshot.state)
        : Uint32Array.from(config.initial);
    const block = new Uint8Array(config.blockSize);
    if (snapshot)
    {
        block.set(snapshot.block);
    }
    let blockLen = snapshot ? snapshot.blockLen : 0;
    let total = snapshot ? snapshot.total : 0;

    /** @param {Uint8Array} bytes */
    const update = bytes=>{
        total += bytes.length;
        let at = 0;
        if (blockLen > 0)
        {
            const take = Math.min(config.blockSize - blockLen, bytes.length);
            block.set(bytes.subarray(0, take), blockLen);
            blockLen += take;
            at = take;
            if (blockLen === config.blockSize)
            {
                config.compress(state, block, 0);
                blockLen = 0;
            }
        }
        while (at + config.blockSize <= bytes.length)
        {
            config.compress(state, bytes, at);
            at += config.blockSize;
        }
        if (at < bytes.length)
        {
            block.set(bytes.subarray(at), 0);
            blockLen = bytes.length - at;
        }
    };

    const digest = ()=>{
        const st = Uint32Array.from(state);
        const bitHi = Math.floor(total / 536870912);
        const bitLo = (total * 8) >>> 0;
        // One 0x80, then zeros until only the eight length bytes are left.
        let tail = 1;
        while ((blockLen + tail) % config.blockSize !== config.blockSize - 8)
        {
            tail++;
        }
        const pad = new Uint8Array(tail + 8);
        pad[0] = 0x80;
        const lenAt = pad.length - 8;
        if (config.littleEndian)
        {
            writeU32LE(pad, lenAt, bitLo);
            writeU32LE(pad, lenAt + 4, bitHi);
        }
        else
        {
            writeU32BE(pad, lenAt, bitHi);
            writeU32BE(pad, lenAt + 4, bitLo);
        }
        const last = new Uint8Array(blockLen + pad.length);
        last.set(block.subarray(0, blockLen));
        last.set(pad, blockLen);
        for (let at = 0; at < last.length; at += config.blockSize)
        {
            config.compress(st, last, at);
        }
        const out = new Uint8Array(st.length * 4);
        for (let w = 0; w < st.length; w++)
        {
            if (config.littleEndian)
            {
                writeU32LE(out, w * 4, st[w]);
            }
            else
            {
                writeU32BE(out, w * 4, st[w]);
            }
        }
        return out;
    };

    const clone = ()=>createBlockHash(config, { state, block, blockLen, total });

    return { update, digest, clone };
}

/** @returns {Digest} */
export const createMd5 = ()=>createBlockHash(MD5_CONFIG);

/** @returns {Digest} */
export const createSha1 = ()=>createBlockHash(SHA1_CONFIG);

/** @returns {Digest} */
export const createSha256 = ()=>createBlockHash(SHA256_CONFIG);
