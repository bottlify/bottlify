/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A translation store's record as it lies in the records file: a byte that says
 * how, then the bytes. 0: as they are; 1: compressed, raw deflate (RFC 1951).
 *
 * Translated code is wasm, which deflate makes five to six times smaller (a
 * cold run of Crysis's CPU benchmark: 1.19 GB of records, its first 200 MB to
 * 30.6 MB at the default level). A record is compressed by the platform's
 * `CompressionStream` as it is written, which is asynchronous as the write is,
 * and read back by `unframe` here, synchronously: an executor reads records
 * through a synchronous handle of its own between two slices, and the
 * platform's `DecompressionStream` has no synchronous form.
 */

/** Records under this many bytes are kept as they are: a region's few hundred. */
const SMALLEST_COMPRESSED = 1024;

/**
 * The record framed, compressed where that makes it smaller.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function frame(bytes){
    if (bytes.length >= SMALLEST_COMPRESSED && typeof CompressionStream === 'function')
    {
        const part = /** @type {BlobPart} */ (bytes);
        const reader = new Blob([part]).stream()
            .pipeThrough(new CompressionStream('deflate-raw')).getReader();
        // The stream's pieces go straight behind the kind byte: joined by the
        // platform first (`Response.arrayBuffer`), they were copied twice.
        /** @type {Uint8Array[]} */
        const pieces = [];
        let length = 1;
        for (let read = await reader.read(); !read.done; read = await reader.read())
        {
            pieces.push(read.value);
            length += read.value.length;
        }
        if (length < bytes.length)
        {
            const out = new Uint8Array(length);
            out[0] = 1;
            let at = 1;
            for (const piece of pieces)
            {
                out.set(piece, at);
                at += piece.length;
            }
            return out;
        }
    }
    return plain(bytes);
}

/**
 * The record framed as it is: the first piece of one that grows by appends.
 *
 * @param {Uint8Array} bytes
 */
export function plain(bytes){
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes, 1);
    return out;
}

/**
 * The record's bytes back, or null for a frame of no known kind (another
 * version's, or a record cut short).
 *
 * @param {Uint8Array} framed
 * @returns {Uint8Array | null}
 */
export function unframe(framed){
    if (framed.length === 0)
    {
        return null;
    }
    if (framed[0] === 0)
    {
        return framed.subarray(1);
    }
    if (framed[0] === 1)
    {
        try
        {
            return inflateRaw(framed.subarray(1));
        }
        catch {
            return null;
        }
    }
    return null;
}

/**
 * `unframe` where the reader may wait: the platform's own inflate, three times
 * this file's, where it has one.
 *
 * @param {Uint8Array | null} framed
 * @returns {Promise<Uint8Array | null>}
 */
export async function unframeLater(framed){
    if (framed === null || framed[0] !== 1 || typeof DecompressionStream !== 'function')
    {
        return framed === null ? null : unframe(framed);
    }
    try
    {
        const part = /** @type {BlobPart} */ (framed.subarray(1));
        const stream = new Blob([part]).stream()
            .pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    catch {
        return null;
    }
}

/* Raw deflate (RFC 1951, section 3.2), read whole. */

/** Lengths 257-285: base and extra bits. */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
    67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
    5, 5, 5, 5, 0];
/** Distances 0-29: base and extra bits. */
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13];
/** The order the code length code's lengths come in. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** The longest code deflate allows. */
const MAX_BITS = 15;

/**
 * A canonical Huffman code as a lookup table over its longest code's bits, read
 * least significant first as deflate packs them: each entry the symbol in its
 * low 16 bits and its code's length above, 0 for no code.
 *
 * @param {Uint8Array} lengths  a code length per symbol, 0 for none
 * @returns {{ table: Int32Array, bits: number }}
 */
function huffman(lengths){
    let bits = 0;
    const count = new Uint16Array(MAX_BITS + 1);
    for (const length of lengths)
    {
        count[length]++;
        bits = Math.max(bits, length);
    }
    count[0] = 0;
    const next = new Uint16Array(MAX_BITS + 2);
    let code = 0;
    for (let length = 1; length <= MAX_BITS; length++)
    {
        code = (code + count[length - 1]) << 1;
        next[length] = code;
    }
    const table = new Int32Array(1 << Math.max(bits, 1));
    for (let symbol = 0; symbol < lengths.length; symbol++)
    {
        const length = lengths[symbol];
        if (length === 0)
        {
            continue;
        }
        // The code's bits reversed: the stream gives them first bit first.
        let reversed = 0;
        for (let i = 0, c = next[length]++; i < length; i++, c >>= 1)
        {
            reversed = (reversed << 1) | (c & 1);
        }
        for (let fill = reversed; fill < table.length; fill += 1 << length)
        {
            table[fill] = (length << 16) | symbol;
        }
    }
    return { table, bits };
}

/** The fixed codes (section 3.2.6), made once. */
let fixed = /** @type {{ literals: ReturnType<typeof huffman>,
    distances: ReturnType<typeof huffman> } | null} */ (null);

/**
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function inflateRaw(input){
    let out = new Uint8Array(Math.max(1024, input.length * 4));
    let written = 0;
    let at = 0;
    let bitBuffer = 0;
    let bitCount = 0;
    /** @param {number} n */
    const need = n=>{
        while (bitCount < n)
        {
            if (at >= input.length)
            {
                throw new Error('deflate: input ends inside a block');
            }
            bitBuffer |= input[at++] << bitCount;
            bitCount += 8;
        }
    };
    /** @param {number} n */
    const take = n=>{
        need(n);
        const value = bitBuffer & ((1 << n) - 1);
        bitBuffer >>>= n;
        bitCount -= n;
        return value;
    };
    /** @param {ReturnType<typeof huffman>} code */
    const symbol = code=>{
        // Peeks at the table's width, or what the input has left at its end.
        while (bitCount < code.bits && at < input.length)
        {
            bitBuffer |= input[at++] << bitCount;
            bitCount += 8;
        }
        const entry = code.table[bitBuffer & ((1 << code.bits) - 1)];
        const length = entry >>> 16;
        if (length === 0 || length > bitCount)
        {
            throw new Error('deflate: no such code');
        }
        bitBuffer >>>= length;
        bitCount -= length;
        return entry & 0xffff;
    };
    /** @param {number} n */
    const room = n=>{
        if (written + n > out.length)
        {
            const grown = new Uint8Array(Math.max(out.length * 2, written + n));
            grown.set(out.subarray(0, written));
            out = grown;
        }
    };
    let last = 0;
    while (!last)
    {
        last = take(1);
        const type = take(2);
        if (type === 0)
        {
            // Stored: to the byte, then a length and its complement.
            bitBuffer = 0;
            bitCount = 0;
            if (at + 4 > input.length)
            {
                throw new Error('deflate: stored block cut short');
            }
            const length = input[at] | (input[at + 1] << 8);
            if ((length ^ (input[at + 2] | (input[at + 3] << 8))) !== 0xffff)
            {
                throw new Error('deflate: stored block length');
            }
            at += 4;
            if (at + length > input.length)
            {
                throw new Error('deflate: stored block cut short');
            }
            room(length);
            out.set(input.subarray(at, at + length), written);
            written += length;
            at += length;
            continue;
        }
        let literals;
        let distances;
        if (type === 1)
        {
            if (fixed === null)
            {
                const lengths = new Uint8Array(288);
                lengths.fill(8, 0, 144);
                lengths.fill(9, 144, 256);
                lengths.fill(7, 256, 280);
                lengths.fill(8, 280, 288);
                fixed = { literals: huffman(lengths),
                    distances: huffman(new Uint8Array(30).fill(5)) };
            }
            ({ literals, distances } = fixed);
        }
        else if (type === 2)
        {
            const literalCount = take(5) + 257;
            const distanceCount = take(5) + 1;
            const codeCount = take(4) + 4;
            const codeLengths = new Uint8Array(19);
            for (let i = 0; i < codeCount; i++)
            {
                codeLengths[CODE_LENGTH_ORDER[i]] = take(3);
            }
            const lengthCode = huffman(codeLengths);
            const lengths = new Uint8Array(literalCount + distanceCount);
            for (let i = 0; i < lengths.length;)
            {
                const s = symbol(lengthCode);
                if (s < 16)
                {
                    lengths[i++] = s;
                    continue;
                }
                let repeat;
                let value = 0;
                if (s === 16)
                {
                    if (i === 0)
                    {
                        throw new Error('deflate: a repeat with nothing before it');
                    }
                    value = lengths[i - 1];
                    repeat = 3 + take(2);
                }
                else
                {
                    repeat = s === 17 ? 3 + take(3) : 11 + take(7);
                }
                if (i + repeat > lengths.length)
                {
                    throw new Error('deflate: code lengths overrun');
                }
                lengths.fill(value, i, i + repeat);
                i += repeat;
            }
            literals = huffman(lengths.subarray(0, literalCount));
            distances = huffman(lengths.subarray(literalCount));
        }
        else
        {
            throw new Error('deflate: block type 3');
        }
        for (;;)
        {
            const s = symbol(literals);
            if (s < 256)
            {
                if (written === out.length)
                {
                    room(1);
                }
                out[written++] = s;
                continue;
            }
            if (s === 256)
            {
                break;
            }
            const index = s - 257;
            if (index >= LENGTH_BASE.length)
            {
                throw new Error('deflate: length symbol');
            }
            const length = LENGTH_BASE[index] + take(LENGTH_EXTRA[index]);
            const d = symbol(distances);
            if (d >= DISTANCE_BASE.length)
            {
                throw new Error('deflate: distance symbol');
            }
            const distance = DISTANCE_BASE[d] + take(DISTANCE_EXTRA[d]);
            if (distance > written)
            {
                throw new Error('deflate: distance past the start');
            }
            room(length);
            const from = written - distance;
            if (distance >= length && length > 16)
            {
                out.copyWithin(written, from, from + length);
                written += length;
            }
            else
            {
                // Byte by byte: a copy may overlap what it writes.
                for (let i = 0; i < length; i++)
                {
                    out[written++] = out[from + i];
                }
            }
        }
    }
    return out.subarray(0, written);
}
