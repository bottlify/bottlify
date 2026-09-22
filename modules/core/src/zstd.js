/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A decode-only zstd (RFC 8878) implementation, so a bundle block can be
 * decoded synchronously inside a guest file read without the emulator's own
 * wasm carrying the only decoder the product has.
 *
 * Supported: concatenated and skippable frames; raw, RLE and compressed
 * blocks; literals in all four encodings (raw, RLE, compressed and treeless
 * Huffman, one or four streams); FSE tables in all four modes (predefined,
 * RLE, compressed, repeat); the sequences with the three repeat offsets; the
 * window. Not supported: dictionaries (a frame naming one is refused) and a
 * window larger than 128 MiB. The content checksum is read and not verified.
 *
 * The bitstreams are read from their end backward, as the format writes them
 * forward; the only bits consulted past the beginning are the zero padding a
 * stream is allowed to assume.
 */

const MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE = 0x184d2a50;
const MAX_WINDOW = 128 * 1024 * 1024;

/** Hints the tests read: which encodings the frames actually used. */
export const zstdStats = {
    frames: 0, rawBlocks: 0, rleBlocks: 0, compressedBlocks: 0,
    rawLiterals: 0, rleLiterals: 0, compressedLiterals: 0, treelessLiterals: 0,
    huffmanFse: 0, huffmanDirect: 0, huffmanOneStream: 0, huffmanFourStreams: 0,
    fsePredefined: 0, fseRle: 0, fseCompressed: 0, fseRepeat: 0,
    sequences: 0,
};

/** Resets the counters, for a test that measures one input. */
export function resetZstdStats(){
    for (const key of Object.keys(zstdStats))
    {
        zstdStats[/** @type {keyof typeof zstdStats} */ (key)] = 0;
    }
}

/** @param {number} value */
function highBit(value){
    return 31 - Math.clz32(value >>> 0);
}

/** @param {Uint8Array} bytes @param {number} at */
function u16(bytes, at){
    return bytes[at] | (bytes[at + 1] << 8);
}

/** @param {Uint8Array} bytes @param {number} at */
function u24(bytes, at){
    return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

/** @param {Uint8Array} bytes @param {number} at */
function u32(bytes, at){
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
        | (bytes[at + 3] * 0x1000000)) >>> 0;
}

/**
 * A forward, little-endian bit reader, for FSE distribution tables and
 * Huffman tree headers. Bits past the end read as zero; the caller learns a
 * table's size from its consumed byte count.
 */
class ForwardBits {
    /** @param {Uint8Array} bytes @param {number} at */
    constructor(bytes, at){
        this.bytes = bytes;
        this.bit = at * 8;
    }

    /** @param {number} n @returns {number} */
    peek(n){
        const base = this.bit >> 3;
        const shift = this.bit & 7;
        let word = 0;
        let mul = 1;
        for (let i = 0; i < 5; i++)
        {
            word += (this.bytes[base + i] ?? 0) * mul;
            mul *= 256;
        }
        return Math.floor(word / (2 ** shift)) % (2 ** n);
    }

    /** @param {number} n @returns {number} */
    read(n){
        const value = this.peek(n);
        this.bit += n;
        return value;
    }

    /** @param {number} n */
    skip(n){
        this.bit += n;
    }
}

/**
 * A backward, little-endian bit reader, as the format's FSE and Huffman
 * streams are written. The stop bit in the last byte and the zero padding
 * after it are skipped; reads past the beginning answer zero.
 */
class ReverseBits {
    /** @param {Uint8Array} bytes @param {number} start @param {number} end */
    constructor(bytes, start, end){
        this.bytes = bytes;
        this.start = start;
        this.size = end - start;
        this.bit = 0;
        if (this.size > 0)
        {
            const last = bytes[end - 1];
            if (last === 0)
            {
                throw new Error('zstd: corrupt bitstream');
            }
            this.bit = (this.size - 1) * 8 + highBit(last);
        }
    }

    /** @param {number} p @param {number} n @returns {number} */
    extract(p, n){
        const base = p >> 3;
        const shift = p & 7;
        let word;
        if (base >= 0 && base + 3 < this.size)
        {
            const at = this.start + base;
            word = this.bytes[at] | (this.bytes[at + 1] << 8)
                | (this.bytes[at + 2] << 16) | (this.bytes[at + 3] << 24);
        }
        else
        {
            word = 0;
            let mul = 1;
            for (let i = 0; i < 4; i++)
            {
                const at = base + i;
                if (at >= 0 && at < this.size)
                {
                    word |= this.bytes[this.start + at] * mul;
                }
                mul *= 256;
            }
        }
        if (n + shift <= 31)
        {
            return (word >>> shift) & ((1 << n) - 1);
        }
        // Past 31 bits (an offset code at a bit offset) a fifth byte is
        // needed; the arithmetic stays exact below 2^53.
        const at = base + 4;
        const high = at >= 0 && at < this.size ? this.bytes[this.start + at] : 0;
        const value = (word >>> 0) + high * 0x100000000;
        return Math.floor(value / (2 ** shift)) % (2 ** n);
    }

    /** @param {number} n @returns {number} */
    peek(n){
        return this.extract(this.bit - n, n);
    }

    /** @param {number} n @returns {number} */
    read(n){
        const value = this.extract(this.bit - n, n);
        this.bit -= n;
        return value;
    }

    /** @param {number} n */
    skip(n){
        this.bit -= n;
    }
}

/**
 * A growable output with the plain-array indexing a match copy wants.
 */
class Output {
    /** @param {number} capacity */
    constructor(capacity){
        this.bytes = new Uint8Array(Math.max(capacity, 1024));
        this.length = 0;
    }

    /** @param {number} n */
    ensure(n){
        if (this.length + n <= this.bytes.length)
        {
            return;
        }
        let size = this.bytes.length;
        while (size < this.length + n)
        {
            size *= 2;
        }
        const larger = new Uint8Array(size);
        larger.set(this.bytes.subarray(0, this.length));
        this.bytes = larger;
    }
}

/**
 * Builds the FSE decoding table of a normalized distribution: the low
 * probability symbols take the last cells, the rest are spread by the
 * format's step, and each cell learns how many bits its next state reads.
 *
 * Exported for the tests: the three off-by-one traps of table construction
 * (the "less than one" count, the baseline/bit accumulation, the state
 * update order) are only visible against the format's own worked example.
 *
 * @param {number[]} probs   normalized counts, -1 for "less than one"
 * @param {number} accuracyLog
 * @returns {{ symbol: number, numBits: number, baseline: number }[]}
 */
export function buildFseTable(probs, accuracyLog){
    const size = 1 << accuracyLog;
    /** @type {{ symbol: number, numBits: number, baseline: number }[]} */
    const table = new Array(size);
    const next = new Int32Array(probs.length);
    let high = size - 1;
    for (let symbol = 0; symbol < probs.length; symbol++)
    {
        if (probs[symbol] === -1)
        {
            table[high--] = { symbol, numBits: accuracyLog, baseline: 0 };
            next[symbol] = 1;
        }
        else
        {
            next[symbol] = probs[symbol];
        }
    }
    const step = (size >> 1) + (size >> 3) + 3;
    const mask = size - 1;
    let position = 0;
    for (let symbol = 0; symbol < probs.length; symbol++)
    {
        for (let i = 0; i < probs[symbol]; i++)
        {
            table[position] = { symbol, numBits: 0, baseline: 0 };
            position = (position + step) & mask;
            while (position > high)
            {
                position = (position + step) & mask;
            }
        }
    }
    for (const cell of table)
    {
        const state = next[cell.symbol]++;
        cell.numBits = accuracyLog - highBit(state);
        cell.baseline = (state << cell.numBits) - size;
    }
    return table;
}

/**
 * One FSE table as the block carries it: a full decoding table, or an RLE
 * symbol that every sequence uses.
 *
 * @typedef {{ log: number, states: { symbol: number, numBits: number,
 *     baseline: number }[] } | { rle: number }} FseTable
 */

/**
 * The distribution table a compressed block carries for one symbol type.
 *
 * @param {ForwardBits} bits
 * @param {number} maxSymbol @param {number} maxAccuracy
 * @returns {{ probs: number[], accuracyLog: number, bytes: number }}
 */
function readFseDistribution(bits, maxSymbol, maxAccuracy){
    const start = bits.bit;
    const accuracyLog = bits.read(4) + 5;
    if (accuracyLog > maxAccuracy)
    {
        throw new Error('zstd: corrupt FSE table');
    }
    const size = 1 << accuracyLog;
    let remaining = size + 1;
    let threshold = size;
    let nbBits = accuracyLog + 1;
    let previous0 = false;
    /** @type {number[]} */
    const probs = [];
    let guard = 0;
    while (remaining > 1 && probs.length <= maxSymbol)
    {
        if (++guard > 4096)
        {
            throw new Error('zstd: corrupt FSE table');
        }
        if (previous0)
        {
            let zeros = 0;
            for (;;)
            {
                const flag = bits.read(2);
                zeros += flag;
                if (flag !== 3)
                {
                    break;
                }
            }
            for (let i = 0; i < zeros && probs.length <= maxSymbol; i++)
            {
                probs.push(0);
            }
        }
        const max = (2 * threshold - 1) - remaining;
        let count;
        if (bits.peek(nbBits - 1) < max)
        {
            count = bits.peek(nbBits - 1);
            bits.skip(nbBits - 1);
        }
        else
        {
            count = bits.peek(nbBits);
            bits.skip(nbBits);
            if (count >= threshold)
            {
                count -= max;
            }
        }
        count--;
        remaining -= count < 0 ? -count : count;
        probs.push(count);
        previous0 = count === 0;
        while (remaining < threshold)
        {
            nbBits--;
            threshold >>= 1;
        }
    }
    return { probs, accuracyLog, bytes: ((bits.bit - start) + 7) >> 3 };
}

/** @param {number[]} probs @param {number} accuracyLog @returns {FseTable} */
function fse(probs, accuracyLog){
    return { log: accuracyLog, states: buildFseTable(probs, accuracyLog) };
}

let predefinedLL = /** @type {FseTable | null} */ (null);
let predefinedML = /** @type {FseTable | null} */ (null);
let predefinedOF = /** @type {FseTable | null} */ (null);

function predefined(){
    predefinedLL ??= fse([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
        2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
    predefinedML ??= fse([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
        -1, -1, -1, -1, -1], 6);
    predefinedOF ??= fse([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);
    return { ll: /** @type {FseTable} */ (predefinedLL),
        ml: /** @type {FseTable} */ (predefinedML),
        of: /** @type {FseTable} */ (predefinedOF) };
}

/** Literals length baselines and bit counts (RFC 8878, Table 16). */
const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
    8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
/** Match length baselines and bit counts (RFC 8878, Table 17). */
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37,
    39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099,
    8195, 16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3,
    4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/**
 * The weights of a Huffman tree encoded by FSE: two interleaved states over
 * one distribution, decoded until an update would need more bits than the
 * stream has left.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} size
 * @returns {number[]}
 */
function readHuffmanWeights(bytes, at, size){
    const forward = new ForwardBits(bytes, at);
    const dist = readFseDistribution(forward, 255, 6);
    const table = buildFseTable(dist.probs, dist.accuracyLog);
    const log = dist.accuracyLog;
    const stream = new ReverseBits(bytes, at + dist.bytes, at + size);
    /** @type {number[]} */
    const weights = [];
    const symbol = (/** @type {number} */ s)=>table[s].symbol;
    const numBits = (/** @type {number} */ s)=>table[s].numBits;
    const baseline = (/** @type {number} */ s)=>table[s].baseline;
    let state1 = stream.read(log);
    let state2 = stream.read(log);
    for (;;)
    {
        weights.push(symbol(state1));
        if (stream.bit < numBits(state1))
        {
            weights.push(symbol(state2));
            break;
        }
        state1 = baseline(state1) + stream.read(numBits(state1));
        weights.push(symbol(state2));
        if (stream.bit < numBits(state2))
        {
            weights.push(symbol(state1));
            break;
        }
        state2 = baseline(state2) + stream.read(numBits(state2));
    }
    return weights;
}

/**
 * The weights of a Huffman tree to its decoding table.
 *
 * @param {number[]} weights  one per symbol so far, 0 for absent; the last
 *     symbol's weight is deduced and appended
 * @returns {{ symbols: Uint8Array, bits: Uint8Array, maxBits: number }}
 */
function buildHuffman(weights){
    let total = 0;
    for (const weight of weights)
    {
        if (weight > 0)
        {
            total += 1 << (weight - 1);
        }
    }
    const maxBits = highBit(total) + 1;
    weights.push((1 << maxBits) - total);
    /** @type {number[]} */
    const count = new Array(maxBits + 1).fill(0);
    for (const weight of weights)
    {
        if (weight > 0)
        {
            count[weight]++;
        }
    }
    const start = new Array(maxBits + 2).fill(0);
    let next = 0;
    for (let weight = 1; weight <= maxBits; weight++)
    {
        start[weight] = next;
        next += count[weight] << (weight - 1);
    }
    const symbols = new Uint8Array(1 << maxBits);
    const bits = new Uint8Array(1 << maxBits);
    for (let symbol = 0; symbol < weights.length; symbol++)
    {
        const weight = weights[symbol];
        if (weight === 0)
        {
            continue;
        }
        const run = 1 << (weight - 1);
        const width = maxBits + 1 - weight;
        const from = start[weight];
        const to = from + run;
        bits.fill(width, from, to);
        symbols.fill(symbol, from, to);
        start[weight] = to;
    }
    return { symbols, bits, maxBits };
}

/**
 * A Huffman tree as a Compressed_Literals_Block carries one.
 *
 * @typedef {{ symbols: Uint8Array, bits: Uint8Array, maxBits: number,
 *     bytes: number }} Huffman
 */

/**
 * @param {Uint8Array} bytes @param {number} at @returns {Huffman}
 */
function readHuffmanTree(bytes, at){
    const header = bytes[at];
    const start = at;
    at++;
    /** @type {number[]} */
    let weights;
    if (header >= 128)
    {
        zstdStats.huffmanDirect++;
        const symbols = header - 127;
        weights = [];
        for (let i = 0; i < symbols; i++)
        {
            const byte = bytes[at + (i >> 1)];
            weights.push((i & 1) === 0 ? byte >> 4 : byte & 0x0f);
        }
        at += (symbols + 1) >> 1;
    }
    else
    {
        zstdStats.huffmanFse++;
        weights = readHuffmanWeights(bytes, at, header);
        at += header;
    }
    const { symbols, bits, maxBits } = buildHuffman(weights);
    return { symbols, bits, maxBits, bytes: at - start };
}

/**
 * One Huffman-coded stream, read backward, into `out` at `outAt`.
 *
 * @param {Uint8Array} bytes @param {number} start @param {number} end
 * @param {Uint8Array} symbols @param {Uint8Array} bits @param {number} maxBits
 * @param {Uint8Array} out @param {number} outAt @param {number} count
 */
function decodeHuffmanStream(bytes, start, end, symbols, bits, maxBits, out, outAt, count){
    const stream = new ReverseBits(bytes, start, end);
    for (let i = 0; i < count; i++)
    {
        const cell = stream.peek(maxBits);
        out[outAt + i] = symbols[cell];
        stream.skip(bits[cell]);
    }
}

/**
 * The literals of a compressed block, in any of their encodings.
 *
 * @param {Uint8Array} bytes @param {number} start
 * @param {{ huffman: Huffman | null }} frame
 * @returns {{ literals: Uint8Array, at: number }}
 */
function decodeLiterals(bytes, start, frame){
    const first = bytes[start];
    const type = first & 3;
    const format = (first >> 2) & 3;
    let header;
    let regenerated;
    let compressed;
    let streams;
    if (type === 0 || type === 1)
    {
        if (format === 0 || format === 2)
        {
            header = 1;
            regenerated = first >> 3;
        }
        else if (format === 1)
        {
            header = 2;
            regenerated = (first >> 4) + (bytes[start + 1] << 4);
        }
        else
        {
            header = 3;
            regenerated = (first >> 4) + (bytes[start + 1] << 4) + (bytes[start + 2] << 12);
        }
        if (type === 0)
        {
            zstdStats.rawLiterals++;
            return {
                literals: bytes.subarray(start + header, start + header + regenerated),
                at: start + header + regenerated,
            };
        }
        zstdStats.rleLiterals++;
        return {
            literals: new Uint8Array(regenerated).fill(bytes[start + header]),
            at: start + header + 1,
        };
    }
    if (format === 0 || format === 1)
    {
        header = 3;
        const value = first + (bytes[start + 1] << 8) + (bytes[start + 2] << 16);
        regenerated = (value >> 4) & 0x3ff;
        compressed = (value >> 14) & 0x3ff;
        streams = format === 0 ? 1 : 4;
    }
    else if (format === 2)
    {
        header = 4;
        const value = first + (bytes[start + 1] << 8) + (bytes[start + 2] << 16)
            + bytes[start + 3] * 0x1000000;
        regenerated = (value >> 4) & 0x3fff;
        compressed = (value >> 18) & 0x3fff;
        streams = 4;
    }
    else
    {
        header = 5;
        const value = first + (bytes[start + 1] << 8) + (bytes[start + 2] << 16)
            + bytes[start + 3] * 0x1000000 + bytes[start + 4] * 0x100000000;
        regenerated = Math.floor(value / 16) % 0x40000;
        compressed = Math.floor(value / 0x400000) % 0x40000;
        streams = 4;
    }
    const contentAt = start + header;
    const contentEnd = contentAt + compressed;
    let tree = frame.huffman;
    let treeSize = 0;
    if (type === 2)
    {
        zstdStats.compressedLiterals++;
        const read = readHuffmanTree(bytes, contentAt);
        tree = read;
        treeSize = read.bytes;
        frame.huffman = read;
    }
    else
    {
        zstdStats.treelessLiterals++;
    }
    if (tree === null)
    {
        throw new Error('zstd: compressed literals without a tree');
    }
    const literals = new Uint8Array(regenerated);
    if (streams === 1)
    {
        zstdStats.huffmanOneStream++;
        decodeHuffmanStream(bytes, contentAt + treeSize, contentEnd, tree.symbols,
            tree.bits, tree.maxBits, literals, 0, regenerated);
    }
    else
    {
        zstdStats.huffmanFourStreams++;
        const per = (regenerated + 3) >> 2;
        const streamsAt = contentAt + treeSize;
        const s1 = u16(bytes, streamsAt);
        const s2 = u16(bytes, streamsAt + 2);
        const s3 = u16(bytes, streamsAt + 4);
        const s4 = (contentEnd - streamsAt) - 6 - s1 - s2 - s3;
        const sizes = [s1, s2, s3, s4];
        const counts = [per, per, per, regenerated - 3 * per];
        let at = streamsAt + 6;
        for (let i = 0; i < 4; i++)
        {
            if (sizes[i] < 0)
            {
                throw new Error('zstd: corrupt jump table');
            }
            decodeHuffmanStream(bytes, at, at + sizes[i], tree.symbols, tree.bits,
                tree.maxBits, literals, i * per, counts[i]);
            at += sizes[i];
        }
    }
    return { literals, at: contentEnd };
}

/**
 * The frame's carried state across its compressed blocks.
 *
 * @typedef {Object} Frame
 * @property {Huffman | null} huffman
 * @property {FseTable | null} ll
 * @property {FseTable | null} ml
 * @property {FseTable | null} of
 * @property {number} repeat1 @property {number} repeat2 @property {number} repeat3
 * @property {number} window
 */

/**
 * Decodes one compressed block into `out`, answering the new output length.
 *
 * @param {Uint8Array} bytes @param {number} start @param {number} end
 * @param {Output} out
 * @param {Frame} frame
 */
function decodeCompressed(bytes, start, end, out, frame){
    const lit = decodeLiterals(bytes, start, frame);
    const literals = lit.literals;
    let at = lit.at;
    let sequences;
    const b0 = bytes[at++];
    if (b0 === 0)
    {
        sequences = 0;
    }
    else if (b0 < 128)
    {
        sequences = b0;
    }
    else if (b0 < 255)
    {
        sequences = ((b0 - 128) << 8) + bytes[at++];
    }
    else
    {
        sequences = bytes[at] + (bytes[at + 1] << 8) + 0x7f00;
        at += 2;
    }
    zstdStats.sequences += sequences;
    if (sequences === 0)
    {
        out.ensure(literals.length);
        for (let i = 0; i < literals.length; i++)
        {
            out.bytes[out.length++] = literals[i];
        }
        return;
    }
    const modes = bytes[at++];
    const llMode = (modes >> 6) & 3;
    const ofMode = (modes >> 4) & 3;
    const mlMode = (modes >> 2) & 3;
    /**
     * @param {number} mode @param {'ll' | 'of' | 'ml'} kind
     * @param {number} maxSymbol @param {number} maxAccuracy
     * @returns {FseTable | null}
     */
    const choose = (mode, kind, maxSymbol, maxAccuracy)=>{
        if (mode === 0)
        {
            zstdStats.fsePredefined++;
            return predefined()[kind];
        }
        if (mode === 1)
        {
            zstdStats.fseRle++;
            return { rle: bytes[at++] };
        }
        if (mode === 2)
        {
            zstdStats.fseCompressed++;
            const forward = new ForwardBits(bytes, at);
            const dist = readFseDistribution(forward, maxSymbol, maxAccuracy);
            at += dist.bytes;
            return fse(dist.probs, dist.accuracyLog);
        }
        zstdStats.fseRepeat++;
        return null;
    };
    const llTable = choose(llMode, 'll', 35, 9) ?? frame.ll;
    const ofTable = choose(ofMode, 'of', 31, 8) ?? frame.of;
    const mlTable = choose(mlMode, 'ml', 52, 9) ?? frame.ml;
    if (llTable === null || ofTable === null || mlTable === null)
    {
        throw new Error('zstd: repeat FSE table without a previous one');
    }
    frame.ll = llTable;
    frame.of = ofTable;
    frame.ml = mlTable;
    const stream = new ReverseBits(bytes, at, end);
    /** @param {FseTable} table @param {number} state */
    const symbolOf = (table, state)=>'rle' in table ? table.rle : table.states[state].symbol;
    /** @param {FseTable} table @param {number} state */
    const bitsOf = (table, state)=>'rle' in table ? 0 : table.states[state].numBits;
    /** @param {FseTable} table @param {number} state */
    const baseOf = (table, state)=>'rle' in table ? 0 : table.states[state].baseline;
    let llState = 'rle' in llTable ? 0 : stream.read(llTable.log);
    let ofState = 'rle' in ofTable ? 0 : stream.read(ofTable.log);
    let mlState = 'rle' in mlTable ? 0 : stream.read(mlTable.log);
    let { repeat1, repeat2, repeat3 } = frame;
    let litAt = 0;
    for (let sequence = 0; sequence < sequences; sequence++)
    {
        const offsetCode = symbolOf(ofTable, ofState);
        const mlCode = symbolOf(mlTable, mlState);
        const llCode = symbolOf(llTable, llState);
        if (offsetCode > 31 || mlCode > 52 || llCode > 35)
        {
            throw new Error('zstd: corrupt sequence symbol');
        }
        const offsetValue = offsetCode === 0
            ? 1
            : (2 ** offsetCode) + stream.read(offsetCode);
        const matchLength = ML_BASE[mlCode] + stream.read(ML_BITS[mlCode]);
        const literalLength = LL_BASE[llCode] + stream.read(LL_BITS[llCode]);
        let offset;
        if (offsetValue > 3)
        {
            offset = offsetValue - 3;
            repeat3 = repeat2;
            repeat2 = repeat1;
            repeat1 = offset;
        }
        else
        {
            const effective = literalLength === 0 ? offsetValue + 1 : offsetValue;
            if (effective === 1)
            {
                offset = repeat1;
            }
            else if (effective === 2)
            {
                offset = repeat2;
                repeat2 = repeat1;
                repeat1 = offset;
            }
            else if (effective === 3)
            {
                offset = repeat3;
                repeat3 = repeat2;
                repeat2 = repeat1;
                repeat1 = offset;
            }
            else
            {
                offset = repeat1 - 1;
                repeat3 = repeat2;
                repeat2 = repeat1;
                repeat1 = offset;
            }
        }
        if (offset <= 0 || offset > frame.window
            || offset > out.length + literalLength)
        {
            throw new Error('zstd: offset past the window');
        }
        out.ensure(literalLength + matchLength);
        for (let i = 0; i < literalLength; i++)
        {
            out.bytes[out.length++] = literals[litAt++];
        }
        for (let i = 0; i < matchLength; i++)
        {
            out.bytes[out.length] = out.bytes[out.length - offset];
            out.length++;
        }
        if (sequence + 1 < sequences)
        {
            llState = baseOf(llTable, llState) + stream.read(bitsOf(llTable, llState));
            mlState = baseOf(mlTable, mlState) + stream.read(bitsOf(mlTable, mlState));
            ofState = baseOf(ofTable, ofState) + stream.read(bitsOf(ofTable, ofState));
        }
    }
    while (litAt < literals.length)
    {
        out.ensure(1);
        out.bytes[out.length++] = literals[litAt++];
    }
    frame.repeat1 = repeat1;
    frame.repeat2 = repeat2;
    frame.repeat3 = repeat3;
}

/**
 * Decodes one frame starting at `at`, answering its bytes and the offset of
 * the next frame (or of the end).
 *
 * @param {Uint8Array} packed @param {number} at
 * @returns {{ bytes: Uint8Array, at: number }}
 */
function decodeFrame(packed, at){
    zstdStats.frames++;
    at += 4;
    if (at + 2 > packed.length)
    {
        throw new Error('zstd: frame ended before it was supposed to');
    }
    const descriptor = packed[at++];
    const fcs = descriptor >> 6;
    const single = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    const dict = descriptor & 3;
    // The order is the format's: the window descriptor (when there is one),
    // then the dictionary id, then the frame content size.
    let window = 0;
    if (!single)
    {
        const wd = packed[at++];
        const base = 2 ** (10 + (wd >> 3));
        window = base + (base / 8) * (wd & 7);
        if (window > MAX_WINDOW)
        {
            throw new Error('zstd: unsupported window');
        }
    }
    let dictId = 0;
    if (dict === 1)
    {
        dictId = packed[at++];
    }
    else if (dict === 2)
    {
        dictId = u16(packed, at);
        at += 2;
    }
    else if (dict === 3)
    {
        dictId = u32(packed, at);
        at += 4;
    }
    if (dictId !== 0)
    {
        throw new Error('zstd: unsupported dictionary id');
    }
    /** @type {number} */
    let contentSize;
    if (fcs === 0)
    {
        contentSize = single ? packed[at++] : 0;
    }
    else if (fcs === 1)
    {
        contentSize = u16(packed, at) + 256;
        at += 2;
    }
    else if (fcs === 2)
    {
        contentSize = u32(packed, at);
        at += 4;
    }
    else
    {
        contentSize = u32(packed, at + 4) * 0x100000000 + u32(packed, at);
        at += 8;
    }
    if (single)
    {
        window = contentSize;
    }
    const out = new Output(contentSize > 0 ? contentSize : Math.max(65536, packed.length * 2));
    /** @type {Frame} */
    const frame = {
        huffman: null, ll: null, ml: null, of: null,
        repeat1: 1, repeat2: 4, repeat3: 8,
        window: window > 0 ? window : MAX_WINDOW,
    };
    for (;;)
    {
        if (at + 3 > packed.length)
        {
            throw new Error('zstd: frame ended before it was supposed to');
        }
        const block = u24(packed, at);
        at += 3;
        const last = block & 1;
        const type = (block >> 1) & 3;
        const size = block >> 3;
        if (type === 3)
        {
            throw new Error('zstd: reserved block type');
        }
        if (at + (type === 1 ? 1 : size) > packed.length)
        {
            throw new Error('zstd: frame ended before it was supposed to');
        }
        if (type === 0)
        {
            zstdStats.rawBlocks++;
            out.ensure(size);
            out.bytes.set(packed.subarray(at, at + size), out.length);
            out.length += size;
            at += size;
        }
        else if (type === 1)
        {
            zstdStats.rleBlocks++;
            out.ensure(size);
            out.bytes.fill(packed[at], out.length, out.length + size);
            out.length += size;
            at += 1;
        }
        else
        {
            zstdStats.compressedBlocks++;
            const blockEnd = at + size;
            decodeCompressed(packed, at, blockEnd, out, frame);
            at = blockEnd;
        }
        if (last)
        {
            break;
        }
    }
    if (checksum)
    {
        at += 4;
    }
    return { bytes: out.bytes.subarray(0, out.length), at };
}

/**
 * Decodes a zstd frame (or frames) to its bytes.
 *
 * @param {Uint8Array} packed
 * @param {number} expectedLength  the length the caller needs; a frame that
 *     ends short of it is an error, and the answer is cut to it when longer
 * @returns {Uint8Array}
 */
export function decompressZstd(packed, expectedLength){
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let at = 0;
    while (at < packed.length)
    {
        const magic = u32(packed, at);
        if ((magic & SKIPPABLE_MASK) === SKIPPABLE)
        {
            at += 8 + u32(packed, at + 4);
            continue;
        }
        if (magic !== MAGIC)
        {
            throw new Error('zstd: bad frame magic');
        }
        const frame = decodeFrame(packed, at);
        chunks.push(frame.bytes);
        total += frame.bytes.length;
        at = frame.at;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const chunk of chunks)
    {
        out.set(chunk, o);
        o += chunk.length;
    }
    if (expectedLength > 0 && out.length < expectedLength)
    {
        throw new Error('zstd: frame ended before it was supposed to');
    }
    return expectedLength > 0 ? out.subarray(0, expectedLength) : out;
}
