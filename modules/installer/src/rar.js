/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installing from a RAR archive: a copied disc shipped as a .rar rather than a
 * zip. Unpacked into the same entries `readZip` gives, so `archiveDisc` builds
 * it into a disc like any other archive.
 *
 * RAR 5.0 as RARLAB's technote describes the container: a signature, then
 * blocks of a CRC32, a variable-length header size, a type and flags, an extra
 * area and a data area. Entries are stored or compressed with the RAR 5
 * algorithm -- LZ77 over a dictionary of up to the size the entry names, its
 * symbols Huffman-coded in blocks that each may carry new tables, and the
 * delta, x86 E8/E9 and ARM filters undone on the way out. A solid archive
 * carries the dictionary, the tables and the repeated distances from one entry
 * to the next, which is why the entries are unpacked in order. Each entry's
 * CRC32 is checked. Encrypted archives and entries, multi-volume archives and
 * RAR 1.5 to 4.x are refused by name.
 */

/** @typedef {import('./archive.js').ArchiveEntry} ArchiveEntry */

const SIGNATURE_5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const SIGNATURE_4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];

const HEAD_MAIN = 1;
const HEAD_FILE = 2;
const HEAD_CRYPT = 4;
const HEAD_END = 5;
const MAIN_VOLUME = 0x0001;
const EXTRA_CRYPT = 0x01;

/** Main, distance, low-distance and repeat-length alphabets, and the code-length one. */
const NC = 306;
const DC = 64;
const LDC = 16;
const RC = 44;
const BC = 20;
const TABLE_SIZE = NC + DC + LDC + RC;
const MAX_CODE = 15;

const FILTER_DELTA = 0;
const FILTER_E8 = 1;
const FILTER_E8E9 = 2;
const FILTER_ARM = 3;

/** @param {Blob} blob @param {number} offset @param {number} length */
const slice = async(blob, offset, length)=>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

/** @param {Uint8Array} bytes @param {number[]} signature */
const startsWith = (bytes, signature)=>signature.every((byte, index)=>bytes[index] === byte);

const CRC_TABLE = (()=>{
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++)
    {
        let c = n;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

/** @param {Uint8Array} bytes */
export function crc32(bytes){
    let crc = -1;
    for (let i = 0; i < bytes.length; i++)
    {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

/**
 * Whether a file is a RAR archive of either generation, by its signature.
 *
 * @param {Blob} blob
 */
export async function isRarArchive(blob){
    const head = await slice(blob, 0, 8);
    return startsWith(head, SIGNATURE_5) || startsWith(head, SIGNATURE_4);
}

/** A cursor over a header's bytes, reading the format's little-endian vints. */
class HeaderReader {
    /** @param {Uint8Array} bytes */
    constructor(bytes){
        this.bytes = bytes;
        this.at = 0;
    }

    vint(){
        let value = 0;
        let scale = 1;
        for (;;)
        {
            if (this.at >= this.bytes.length)
            {
                throw new Error('a RAR header ends inside a number');
            }
            const byte = this.bytes[this.at++];
            value += (byte & 0x7f) * scale;
            scale *= 128;
            if (!(byte & 0x80))
            {
                return value;
            }
        }
    }

    u32(){
        const b = this.bytes;
        const value = (b[this.at] | b[this.at + 1] << 8 | b[this.at + 2] << 16
            | b[this.at + 3] << 24) >>> 0;
        this.at += 4;
        return value;
    }
}

/** MSB-first bits over one entry's packed data, padded so a read past its end sees zeros. */
class BitReader {
    /** @param {Uint8Array} data */
    constructor(data){
        this.data = new Uint8Array(data.length + 8);
        this.data.set(data);
        this.addr = 0;
        this.bit = 0;
    }

    /** The next 16 bits, not consumed. */
    peek16(){
        const d = this.data;
        const a = this.addr;
        return ((d[a] << 16 | d[a + 1] << 8 | d[a + 2]) >>> (8 - this.bit)) & 0xffff;
    }

    /** The next 32 bits, not consumed. */
    peek32(){
        const d = this.data;
        const a = this.addr;
        return ((d[a] << 24 | d[a + 1] << 16 | d[a + 2] << 8 | d[a + 3]) << this.bit
            | d[a + 4] >>> (8 - this.bit)) >>> 0;
    }

    /** @param {number} count */
    skip(count){
        const bits = this.bit + count;
        this.addr += bits >> 3;
        this.bit = bits & 7;
    }

    /** @param {number} count  At most 16. */
    read(count){
        const value = this.peek16() >>> (16 - count);
        this.skip(count);
        return value;
    }

    align(){
        if (this.bit)
        {
            this.addr++;
            this.bit = 0;
        }
    }
}

/**
 * A canonical Huffman decoder as one lookup over the longest code: an entry
 * holds the symbol and its length for every word its code prefixes. Codes are
 * assigned by length, then by symbol, the shortest numerically first.
 */
class Decoder {
    /** @param {Uint8Array} lengths */
    constructor(lengths){
        this.table = new Int32Array(1 << MAX_CODE).fill(-1);
        const count = new Int32Array(MAX_CODE + 1);
        for (const length of lengths)
        {
            count[length]++;
        }
        count[0] = 0;
        const next = new Int32Array(MAX_CODE + 2);
        for (let length = 1, code = 0; length <= MAX_CODE; length++)
        {
            code = (code + count[length - 1]) << 1;
            next[length] = code;
        }
        for (let symbol = 0; symbol < lengths.length; symbol++)
        {
            const length = lengths[symbol];
            if (!length)
            {
                continue;
            }
            const code = next[length]++;
            const shift = MAX_CODE - length;
            const first = code << shift;
            if (first + (1 << shift) > this.table.length)
            {
                throw new Error('a RAR Huffman table is oversubscribed');
            }
            this.table.fill(symbol << 4 | length, first, first + (1 << shift));
        }
    }

    /** @param {BitReader} bits */
    decode(bits){
        const entry = this.table[bits.peek16() >>> 1];
        if (entry < 0)
        {
            throw new Error('a RAR Huffman code is not in its table');
        }
        bits.skip(entry & 15);
        return entry >>> 4;
    }
}

/**
 * @typedef {Object} BlockHeader
 * @property {number} end       The byte the block's last bits are in.
 * @property {number} endBits   How many bits of that byte are the block's.
 * @property {boolean} tables
 * @property {boolean} last
 */

/** @param {BitReader} bits @returns {BlockHeader} */
function readBlockHeader(bits){
    bits.align();
    const flags = bits.read(8);
    const sizeBytes = (flags >> 3 & 3) + 1;
    if (sizeBytes === 4)
    {
        throw new Error('a RAR block header is damaged');
    }
    const check = bits.read(8);
    let size = 0;
    for (let i = 0; i < sizeBytes; i++)
    {
        size += bits.read(8) << i * 8;
    }
    if ((0x5a ^ flags ^ size ^ size >> 8 ^ size >> 16) & 0xff ^ check)
    {
        throw new Error('a RAR block header fails its check');
    }
    return { end: bits.addr + size - 1, endBits: (flags & 7) + 1,
        tables: (flags & 0x80) !== 0, last: (flags & 0x40) !== 0 };
}

/**
 * @typedef {Object} Tables
 * @property {Decoder} main
 * @property {Decoder} dist
 * @property {Decoder} low
 * @property {Decoder} rep
 */

/** @param {BitReader} bits @returns {Tables} */
function readTables(bits){
    const codeLengths = new Uint8Array(BC);
    for (let i = 0; i < BC; i++)
    {
        const length = bits.read(4);
        if (length === 15)
        {
            const zeros = bits.read(4);
            if (zeros === 0)
            {
                codeLengths[i] = 15;
            }
            else
            {
                for (let n = zeros + 2; n > 0 && i < BC; n--)
                {
                    codeLengths[i++] = 0;
                }
                i--;
            }
        }
        else
        {
            codeLengths[i] = length;
        }
    }
    const lengthDecoder = new Decoder(codeLengths);
    const lengths = new Uint8Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE;)
    {
        const symbol = lengthDecoder.decode(bits);
        if (symbol < 16)
        {
            lengths[i++] = symbol;
        }
        else
        {
            const count = symbol & 1 ? bits.read(7) + 11 : bits.read(3) + 3;
            if (symbol < 18 && i === 0)
            {
                throw new Error('a RAR table repeats a length before the first');
            }
            const value = symbol < 18 ? lengths[i - 1] : 0;
            for (let n = 0; n < count && i < TABLE_SIZE; n++)
            {
                lengths[i++] = value;
            }
        }
    }
    return {
        main: new Decoder(lengths.subarray(0, NC)),
        dist: new Decoder(lengths.subarray(NC, NC + DC)),
        low: new Decoder(lengths.subarray(NC + DC, NC + DC + LDC)),
        rep: new Decoder(lengths.subarray(NC + DC + LDC)),
    };
}

/** @param {BitReader} bits @param {number} slot */
function slotToLength(bits, slot){
    if (slot < 8)
    {
        return slot + 2;
    }
    const extra = (slot >> 2) - 1;
    return 2 + ((4 | slot & 3) << extra) + bits.read(extra);
}

/** @param {BitReader} bits */
function filterNumber(bits){
    const count = bits.read(2) + 1;
    let value = 0;
    for (let i = 0; i < count; i++)
    {
        value += bits.read(8) * 2 ** (i * 8);
    }
    return value;
}

/**
 * @typedef {Object} Filter
 * @property {number} start     Absolute output position.
 * @property {number} length
 * @property {number} type
 * @property {number} channels
 */

/**
 * @param {Uint8Array} data  The block, filtered in place or into a copy.
 * @param {Filter} filter
 * @param {number} fileOffset  Where the block starts in its entry.
 * @returns {Uint8Array}
 */
function applyFilter(data, filter, fileOffset){
    switch (filter.type)
    {
        case FILTER_E8:
        case FILTER_E8E9: {
            const FILE_SIZE = 0x1000000;
            const second = filter.type === FILTER_E8E9 ? 0xe9 : 0xe8;
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            for (let pos = 0; pos + 4 < data.length;)
            {
                const byte = data[pos++];
                if (byte === 0xe8 || byte === second)
                {
                    const offset = (pos + fileOffset) % FILE_SIZE;
                    const addr = view.getUint32(pos, true);
                    if (addr & 0x80000000)
                    {
                        if (!((addr + offset) & 0x80000000))
                        {
                            view.setUint32(pos, (addr + FILE_SIZE) >>> 0, true);
                        }
                    }
                    else if ((addr - FILE_SIZE) & 0x80000000)
                    {
                        view.setUint32(pos, (addr - offset) >>> 0, true);
                    }
                    pos += 4;
                }
            }
            return data;
        }
        case FILTER_ARM:
            for (let pos = 0; pos + 3 < data.length; pos += 4)
            {
                if (data[pos + 3] === 0xeb)
                {
                    const offset = (data[pos] | data[pos + 1] << 8 | data[pos + 2] << 16)
                        - ((fileOffset + pos) >>> 2);
                    data[pos] = offset;
                    data[pos + 1] = offset >> 8;
                    data[pos + 2] = offset >> 16;
                }
            }
            return data;
        case FILTER_DELTA: {
            const out = new Uint8Array(data.length);
            let src = 0;
            for (let channel = 0; channel < filter.channels; channel++)
            {
                let previous = 0;
                for (let dest = channel; dest < data.length; dest += filter.channels)
                {
                    previous = previous - data[src++] & 0xff;
                    out[dest] = previous;
                }
            }
            return out;
        }
        default:
            throw new Error(`a RAR filter of unknown type ${filter.type}`);
    }
}

/**
 * The state a solid archive carries from entry to entry: the dictionary, the
 * position in it, the tables and the repeated distances.
 */
class Unpacker {
    /** @param {number} dictionary  Bytes. */
    constructor(dictionary){
        let size = 1 << 18;
        while (size < dictionary)
        {
            size *= 2;
        }
        this.window = new Uint8Array(size);
        this.mask = size - 1;
        /** Absolute output position, across entries. */
        this.pos = 0;
        /** The last four distances, the latest first. */
        this.oldDist = [0, 0, 0, 0];
        this.lastLength = 0;
        /** @type {Tables | null} */
        this.tables = null;
    }

    reset(){
        this.pos = 0;
        this.oldDist = [0, 0, 0, 0];
        this.lastLength = 0;
        this.tables = null;
    }

    /** @param {number} dictionary */
    fits(dictionary){
        return this.window.length >= dictionary;
    }

    /**
     * One entry's packed data, unpacked.
     *
     * @param {Uint8Array} packed
     * @param {number} size  Unpacked bytes.
     * @param {boolean} solid
     */
    unpack(packed, size, solid){
        if (!solid)
        {
            this.reset();
        }
        const bits = new BitReader(packed);
        const out = new Uint8Array(size);
        const start = this.pos;
        const window = this.window;
        const mask = this.mask;
        /** @type {Filter[]} */
        const filters = [];
        let flushed = start;
        const flushTo = (/** @type {number} */ limit)=>{
            while (flushed < limit)
            {
                const filter = filters[0];
                const until = filter && filter.start < limit ? filter.start : limit;
                for (let at = flushed; at < until; at++)
                {
                    out[at - start] = window[at & mask];
                }
                flushed = Math.max(flushed, until);
                if (!filter || filter.start >= limit)
                {
                    return;
                }
                const end = filter.start + filter.length;
                if (end > this.pos)
                {
                    return;
                }
                const block = new Uint8Array(filter.length);
                for (let i = 0; i < filter.length; i++)
                {
                    block[i] = window[filter.start + i & mask];
                }
                const filtered = applyFilter(block, filter, filter.start - start);
                const room = Math.min(filter.length, size - (filter.start - start));
                out.set(filtered.subarray(0, room), filter.start - start);
                flushed = end;
                filters.shift();
            }
        };
        const copy = (/** @type {number} */ length, /** @type {number} */ distance)=>{
            let pos = this.pos;
            for (let i = 0; i < length; i++, pos++)
            {
                window[pos & mask] = window[pos - distance & mask];
            }
            this.pos = pos;
        };

        let header = readBlockHeader(bits);
        if (header.tables)
        {
            this.tables = readTables(bits);
        }
        if (!this.tables)
        {
            throw new Error('a RAR entry starts without tables');
        }
        const flushEvery = window.length >> 2;
        for (;;)
        {
            if (bits.addr > header.end || bits.addr === header.end && bits.bit >= header.endBits)
            {
                if (header.last)
                {
                    break;
                }
                header = readBlockHeader(bits);
                if (header.tables)
                {
                    this.tables = readTables(bits);
                }
                continue;
            }
            if (bits.addr >= packed.length + 4)
            {
                throw new Error('a RAR entry runs past its packed data');
            }
            if (this.pos - flushed >= flushEvery)
            {
                flushTo(this.pos);
                if (this.pos - flushed >= window.length - 0x1000)
                {
                    throw new Error('a RAR filter spans more than the dictionary');
                }
            }
            const { main, dist, low, rep } = this.tables;
            const symbol = main.decode(bits);
            if (symbol < 256)
            {
                window[this.pos++ & mask] = symbol;
            }
            else if (symbol >= 262)
            {
                let length = slotToLength(bits, symbol - 262);
                const slot = dist.decode(bits);
                let distance = 1;
                if (slot < 4)
                {
                    distance += slot;
                }
                else
                {
                    const extra = (slot >> 1) - 1;
                    distance += (2 | slot & 1) * 2 ** extra;
                    if (extra >= 4)
                    {
                        if (extra > 4)
                        {
                            distance += (bits.peek32() >>> (36 - extra)) * 16;
                            bits.skip(extra - 4);
                        }
                        distance += low.decode(bits);
                    }
                    else
                    {
                        distance += bits.read(extra);
                    }
                }
                if (distance > 0x100)
                {
                    length++;
                    if (distance > 0x2000)
                    {
                        length++;
                        if (distance > 0x40000)
                        {
                            length++;
                        }
                    }
                }
                this.oldDist.pop();
                this.oldDist.unshift(distance);
                this.lastLength = length;
                copy(length, distance);
            }
            else if (symbol === 256)
            {
                const offset = filterNumber(bits);
                const length = filterNumber(bits);
                const type = bits.read(3);
                const channels = type === FILTER_DELTA ? bits.read(5) + 1 : 0;
                filters.push({ start: this.pos + offset, length, type, channels });
                filters.sort((a, b)=>a.start - b.start);
            }
            else if (symbol === 257)
            {
                if (this.lastLength)
                {
                    copy(this.lastLength, this.oldDist[0]);
                }
            }
            else
            {
                const index = symbol - 258;
                const distance = this.oldDist[index];
                this.oldDist.splice(index, 1);
                this.oldDist.unshift(distance);
                const length = slotToLength(bits, rep.decode(bits));
                this.lastLength = length;
                copy(length, distance);
            }
        }
        if (this.pos - start !== size)
        {
            throw new Error(`a RAR entry unpacked to ${this.pos - start} bytes, not ${size}`);
        }
        flushTo(this.pos);
        if (filters.length)
        {
            throw new Error('a RAR filter reaches past its entry');
        }
        return out;
    }
}

/**
 * Every entry of a RAR 5 archive, unpacked, in the archive's order.
 *
 * @param {Blob} blob
 * @param {(done: number, total: number) => void} [progress]  Bytes of the archive read so far.
 * @returns {Promise<ArchiveEntry[]>}
 */
export async function readRar(blob, progress){
    const head = await slice(blob, 0, 8);
    if (startsWith(head, SIGNATURE_4))
    {
        throw new Error('RAR 1.5 to 4.x archives are not supported, only RAR 5');
    }
    if (!startsWith(head, SIGNATURE_5))
    {
        throw new Error('not a RAR archive');
    }
    /** @type {ArchiveEntry[]} */
    const entries = [];
    /** @type {Unpacker | null} */
    let unpacker = null;
    let at = 8;
    while (at < blob.size)
    {
        // CRC32, then the header size as a vint of at most three bytes.
        const prefix = await slice(blob, at, 7);
        const sizeReader = new HeaderReader(prefix.subarray(4));
        const headerSize = sizeReader.vint();
        const headerStart = at + 4 + sizeReader.at;
        const reader = new HeaderReader(await slice(blob, headerStart, headerSize));
        const type = reader.vint();
        const flags = reader.vint();
        const extraSize = flags & 1 ? reader.vint() : 0;
        const dataSize = flags & 2 ? reader.vint() : 0;
        const dataAt = headerStart + headerSize;
        if (type === HEAD_CRYPT)
        {
            throw new Error('encrypted RAR archives are not supported');
        }
        if (type === HEAD_MAIN && reader.vint() & MAIN_VOLUME)
        {
            throw new Error('multi-volume RAR archives are not supported');
        }
        if (type === HEAD_FILE)
        {
            const fileFlags = reader.vint();
            const size = reader.vint();
            reader.vint();
            if (fileFlags & 2)
            {
                reader.at += 4;
            }
            const crc = fileFlags & 4 ? reader.u32() : null;
            const compression = reader.vint();
            reader.vint();
            const nameLength = reader.vint();
            const path = new TextDecoder()
                .decode(reader.bytes.subarray(reader.at, reader.at + nameLength))
                .replace(/\//g, '\\');
            reader.at += nameLength;
            const extraEnd = reader.at + extraSize;
            while (reader.at < extraEnd)
            {
                const recordSize = reader.vint();
                const next = reader.at + recordSize;
                if (reader.vint() === EXTRA_CRYPT)
                {
                    throw new Error(`${path}: encrypted RAR entries are not supported`);
                }
                reader.at = next;
            }
            if (fileFlags & 1)
            {
                entries.push({ path, bytes: null });
            }
            else
            {
                const method = compression >> 7 & 7;
                const packed = await slice(blob, dataAt, dataSize);
                let bytes;
                if (method === 0)
                {
                    bytes = packed;
                }
                else
                {
                    const dictionary = 0x20000 * 2 ** (compression >> 10 & 15);
                    const solid = (compression & 0x40) !== 0;
                    if (!unpacker || !unpacker.fits(dictionary))
                    {
                        if (solid && unpacker)
                        {
                            throw new Error(
                                `${path}: a solid RAR entry asks for a larger dictionary`);
                        }
                        unpacker = new Unpacker(dictionary);
                    }
                    bytes = unpacker.unpack(packed, size, solid);
                }
                if (bytes.length !== size)
                {
                    throw new Error(
                        `${path}: the RAR entry holds ${bytes.length} bytes, not ${size}`);
                }
                if (crc !== null && crc32(bytes) !== crc)
                {
                    throw new Error(`${path}: the RAR entry fails its CRC32`);
                }
                entries.push({ path, bytes });
            }
        }
        at = dataAt + dataSize;
        progress?.(Math.min(at, blob.size), blob.size);
        if (type === HEAD_END)
        {
            break;
        }
    }
    return entries;
}
