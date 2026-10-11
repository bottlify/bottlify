/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The archive an InstallShield 5 disc carries its engine in (`_inst32i.ex_`):
 * Stirling Technologies' multi-file container, its members compressed with the
 * PKWARE Data Compression Library's implode.
 *
 * The container: a 4-byte signature, four bytes of version, a 70-byte
 * copyright text that fills its field without a terminator, a 32-bit member
 * count, then one record a member -- a 32-bit offset of its data from
 * the start of the file, its compressed and its unpacked size, eight bytes of
 * date, time and attributes, then two counted names: the member's own and the
 * one the setup launcher writes it under in its temporary directory.
 *
 * Implode as the format is known: a byte saying whether literals are coded
 * (1) or stored as bytes (0), a byte giving the dictionary as a power of two
 * kilobytes (4 to 6), then bits read low first -- a 0 bit and a literal, or a
 * 1 bit, a coded length and a coded distance; the length 519 ends the stream.
 * The three Huffman tables are fixed by the format; the codes are sent
 * inverted, which is why `decode` complements each bit it reads.
 */

const SIGNATURE = [0x2a, 0xab, 0x79, 0xd8];
const COUNT_AT = 0x4e;

/**
 * The code lengths of the three fixed tables, run-length packed: a byte's low
 * nibble is a length, its high nibble one less than how many symbols in a row
 * take it.
 */
const LITERAL_LENGTHS = [
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
    9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
    7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
    8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
    44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
    44, 173];
const LENGTH_LENGTHS = [2, 35, 36, 53, 38, 23];
const DISTANCE_LENGTHS = [2, 20, 53, 230, 247, 151, 248];
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAX_BITS = 13;
const END = 519;

/**
 * @typedef {{ count: Uint16Array, symbol: Uint16Array }} Table
 */

/**
 * A canonical table from packed lengths.
 * @param {number[]} packed
 * @param {number} symbols
 * @returns {Table}
 */
function table(packed, symbols){
    const lengths = [];
    for (const byte of packed)
    {
        for (let n = (byte >> 4) + 1; n > 0; n--)
        {
            lengths.push(byte & 15);
        }
    }
    if (lengths.length !== symbols)
    {
        throw new Error(`implode table holds ${lengths.length} lengths, not ${symbols}`);
    }
    const count = new Uint16Array(MAX_BITS + 1);
    for (const length of lengths)
    {
        count[length]++;
    }
    const offsets = new Uint16Array(MAX_BITS + 1);
    for (let length = 1; length < MAX_BITS; length++)
    {
        offsets[length + 1] = offsets[length] + count[length];
    }
    const symbol = new Uint16Array(symbols);
    lengths.forEach((length, value)=>{
        if (length !== 0)
        {
            symbol[offsets[length]++] = value;
        }
    });
    return { count, symbol };
}

const LITERALS = table(LITERAL_LENGTHS, 256);
const LENGTHS = table(LENGTH_LENGTHS, 16);
const DISTANCES = table(DISTANCE_LENGTHS, 64);

/**
 * Unpacks a PKWARE DCL implode stream.
 * @param {Uint8Array} input
 * @param {number} [expected]  The unpacked size, when the container says it.
 * @returns {Uint8Array}
 */
export function explode(input, expected){
    let at = 0;
    let buffer = 0;
    let held = 0;
    /** @param {number} n */
    const bits = n=>{
        while (held < n)
        {
            if (at >= input.length)
            {
                throw new Error('implode stream ends before its end code');
            }
            buffer |= input[at++] << held;
            held += 8;
        }
        const value = buffer & ((1 << n) - 1);
        buffer >>>= n;
        held -= n;
        return value;
    };
    /** @param {Table} codes */
    const decode = codes=>{
        let code = 0;
        let first = 0;
        let index = 0;
        for (let length = 1; length <= MAX_BITS; length++)
        {
            code |= bits(1) ^ 1;
            const count = codes.count[length];
            if (code < first + count)
            {
                return codes.symbol[index + code - first];
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error('implode stream holds a code no table has');
    };
    const coded = bits(8);
    const dictionary = bits(8);
    if (coded > 1 || dictionary < 4 || dictionary > 6)
    {
        throw new Error('not an implode stream');
    }
    let out = new Uint8Array(expected ?? Math.max(4096, input.length * 4));
    let size = 0;
    /** @param {number} extra */
    const room = extra=>{
        if (size + extra > out.length)
        {
            const grown = new Uint8Array(Math.max(out.length * 2, size + extra));
            grown.set(out.subarray(0, size));
            out = grown;
        }
    };
    for (;;)
    {
        if (bits(1))
        {
            const symbol = decode(LENGTHS);
            const length = LENGTH_BASE[symbol] + bits(LENGTH_EXTRA[symbol]);
            if (length === END)
            {
                break;
            }
            const shift = length === 2 ? 2 : dictionary;
            const distance = ((decode(DISTANCES) << shift) | bits(shift)) + 1;
            if (distance > size)
            {
                throw new Error('implode stream reaches back before its start');
            }
            room(length);
            for (let n = 0; n < length; n++, size++)
            {
                out[size] = out[size - distance];
            }
        }
        else
        {
            room(1);
            out[size++] = coded ? decode(LITERALS) : bits(8);
        }
    }
    if (expected !== undefined && size !== expected)
    {
        throw new Error(`implode stream unpacks to ${size} bytes, not ${expected}`);
    }
    return out.subarray(0, size);
}

/**
 * @typedef {object} StirlingMember
 * @property {string} name  The member's own name.
 * @property {string} stored  The name the launcher writes it under.
 * @property {Uint8Array} bytes  Unpacked.
 */

/**
 * Whether the bytes are a Stirling container.
 * @param {Uint8Array} bytes
 */
export function isStirlingArchive(bytes){
    return SIGNATURE.every((byte, index)=>bytes[index] === byte);
}

/**
 * Every member of a Stirling container, unpacked.
 * @param {Uint8Array} bytes
 * @returns {StirlingMember[]}
 */
export function readStirling(bytes){
    if (!isStirlingArchive(bytes))
    {
        throw new Error('not a Stirling archive');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = COUNT_AT;
    const count = view.getUint32(at, true);
    at += 4;
    const text = ()=>{
        const length = view.getUint16(at, true);
        const value = String.fromCharCode(...bytes.subarray(at + 2, at + 2 + length));
        at += 2 + length;
        return value;
    };
    /** @type {StirlingMember[]} */
    const members = [];
    for (let n = 0; n < count; n++)
    {
        const offset = view.getUint32(at, true);
        const packed = view.getUint32(at + 4, true);
        const size = view.getUint32(at + 8, true);
        at += 20;
        const name = text();
        const stored = text();
        if (offset + packed > bytes.length)
        {
            throw new Error(`Stirling member ${n} runs past the end of the archive`);
        }
        const data = bytes.subarray(offset, offset + packed);
        members.push({ name, stored, bytes: explode(data, size) });
    }
    return members;
}
