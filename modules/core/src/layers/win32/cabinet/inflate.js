/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Deflate decoding (RFC 1951), as a cabinet's MSZIP folders use it.
 *
 * The Cabinet SDK's MSZIP description is short: every CFDATA block is the
 * two bytes `CK` and then one complete deflate stream -- stored, fixed or
 * dynamic Huffman sub-blocks, the last marked final -- whose trees are
 * discarded at its end while the 32 KiB history survives into the next
 * block of the same folder. So a decoder here is an object that keeps that
 * history between calls, and a new folder is a new decoder.
 */

/** How far back a distance may reach. */
const HISTORY = 32768;
const HISTORY_MASK = HISTORY - 1;

/** RFC 1951 3.2.5: lengths 257..285, base and extra bits. */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

/** Distances 0..29, base and extra bits. */
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** The order the code length code's own lengths are sent in (3.2.7). */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const MAX_BITS = 15;

/** Thrown for input that is not a deflate stream this decoder can finish. */
export class InflateError extends Error {}

/**
 * A canonical Huffman code as counts per length and the symbols in code
 * order, which is all decoding a bit at a time needs (3.2.2).
 *
 * @typedef {{ counts: Uint16Array, symbols: Uint16Array }} Code
 */

/**
 * @param {ArrayLike<number>} lengths  Code length per symbol, 0 for unused.
 * @returns {Code}
 */
function buildCode(lengths){
    const counts = new Uint16Array(MAX_BITS + 1);
    for (let symbol = 0; symbol < lengths.length; symbol++)
    {
        counts[lengths[symbol]]++;
    }
    counts[0] = 0;
    // Over-subscribed lengths describe no prefix code at all.
    let left = 1;
    for (let length = 1; length <= MAX_BITS; length++)
    {
        left = (left << 1) - counts[length];
        if (left < 0)
        {
            throw new InflateError('over-subscribed code lengths');
        }
    }
    const offsets = new Uint16Array(MAX_BITS + 2);
    for (let length = 1; length <= MAX_BITS; length++)
    {
        offsets[length + 1] = offsets[length] + counts[length];
    }
    const symbols = new Uint16Array(lengths.length);
    for (let symbol = 0; symbol < lengths.length; symbol++)
    {
        if (lengths[symbol] !== 0)
        {
            symbols[offsets[lengths[symbol]]++] = symbol;
        }
    }
    return { counts, symbols };
}

/** The fixed codes of 3.2.6, built once. */
const FIXED = (()=>{
    const literal = new Uint8Array(288);
    literal.fill(8, 0, 144);
    literal.fill(9, 144, 256);
    literal.fill(7, 256, 280);
    literal.fill(8, 280, 288);
    return { literal: buildCode(literal), distance: buildCode(new Uint8Array(30).fill(5)) };
})();

/**
 * A decoder that keeps its history from one stream to the next.
 */
export function createInflater(){
    const history = new Uint8Array(HISTORY);
    let position = 0;

    return {
        /** Forgets the history: the start of a new folder. */
        reset(){
            history.fill(0);
            position = 0;
        },

        /**
         * Decodes one complete deflate stream, reaching back into what the
         * streams before it produced.
         *
         * @param {Uint8Array} input
         * @param {number} [expected]  The size the output will be, when known.
         * @returns {Uint8Array}
         */
        inflate(input, expected = HISTORY){
            let at = 0;
            let bitBuffer = 0;
            let bitCount = 0;
            let out = new Uint8Array(Math.max(expected, 16));
            let written = 0;

            /** @param {number} count */
            const bits = count=>{
                while (bitCount < count)
                {
                    if (at >= input.length)
                    {
                        throw new InflateError('the stream ends inside a block');
                    }
                    bitBuffer |= input[at++] << bitCount;
                    bitCount += 8;
                }
                const value = bitBuffer & ((1 << count) - 1);
                bitBuffer >>>= count;
                bitCount -= count;
                return value;
            };

            /** @param {number} value */
            const emit = value=>{
                if (written === out.length)
                {
                    const grown = new Uint8Array(out.length * 2);
                    grown.set(out);
                    out = grown;
                }
                out[written++] = value;
                history[position] = value;
                position = (position + 1) & HISTORY_MASK;
            };

            /** Huffman codes arrive most significant bit first. @param {Code} code */
            const decode = code=>{
                let value = 0;
                let first = 0;
                let index = 0;
                for (let length = 1; length <= MAX_BITS; length++)
                {
                    value |= bits(1);
                    const count = code.counts[length];
                    if (value - first < count)
                    {
                        return code.symbols[index + value - first];
                    }
                    index += count;
                    first = (first + count) << 1;
                    value <<= 1;
                }
                throw new InflateError('a code no table has');
            };

            /** @param {Code} literals @param {Code} distances */
            const codes = (literals, distances)=>{
                for (;;)
                {
                    const symbol = decode(literals);
                    if (symbol < 256)
                    {
                        emit(symbol);
                        continue;
                    }
                    if (symbol === 256)
                    {
                        return;
                    }
                    const lengthCode = symbol - 257;
                    if (lengthCode >= 29)
                    {
                        throw new InflateError('a length code past 285');
                    }
                    const length = LENGTH_BASE[lengthCode] + bits(LENGTH_EXTRA[lengthCode]);
                    const distanceCode = decode(distances);
                    if (distanceCode >= 30)
                    {
                        throw new InflateError('a distance code past 29');
                    }
                    const distance = DISTANCE_BASE[distanceCode]
                        + bits(DISTANCE_EXTRA[distanceCode]);
                    let from = (position - distance) & HISTORY_MASK;
                    for (let i = 0; i < length; i++)
                    {
                        emit(history[from]);
                        from = (from + 1) & HISTORY_MASK;
                    }
                }
            };

            const dynamic = ()=>{
                const literalCount = bits(5) + 257;
                const distanceCount = bits(5) + 1;
                const lengthCount = bits(4) + 4;
                if (literalCount > 286 || distanceCount > 30)
                {
                    throw new InflateError('too many codes');
                }
                const codeLengths = new Uint8Array(19);
                for (let i = 0; i < lengthCount; i++)
                {
                    codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
                }
                const lengthCode = buildCode(codeLengths);
                const lengths = new Uint8Array(literalCount + distanceCount);
                for (let i = 0; i < lengths.length;)
                {
                    const symbol = decode(lengthCode);
                    if (symbol < 16)
                    {
                        lengths[i++] = symbol;
                        continue;
                    }
                    let repeat;
                    let value = 0;
                    if (symbol === 16)
                    {
                        if (i === 0)
                        {
                            throw new InflateError('a repeat with nothing before it');
                        }
                        value = lengths[i - 1];
                        repeat = 3 + bits(2);
                    }
                    else
                    {
                        repeat = symbol === 17 ? 3 + bits(3) : 11 + bits(7);
                    }
                    if (i + repeat > lengths.length)
                    {
                        throw new InflateError('code lengths overrun');
                    }
                    lengths.fill(value, i, i + repeat);
                    i += repeat;
                }
                if (lengths[256] === 0)
                {
                    throw new InflateError('no end-of-block code');
                }
                codes(buildCode(lengths.subarray(0, literalCount)),
                    buildCode(lengths.subarray(literalCount)));
            };

            let last = 0;
            while (!last)
            {
                last = bits(1);
                const type = bits(2);
                if (type === 0)
                {
                    // Stored: the rest of this byte is dropped, then a length
                    // and its complement.
                    bitBuffer = 0;
                    bitCount = 0;
                    if (at + 4 > input.length)
                    {
                        throw new InflateError('a stored block with no length');
                    }
                    const length = input[at] | (input[at + 1] << 8);
                    const complement = input[at + 2] | (input[at + 3] << 8);
                    at += 4;
                    if ((length ^ 0xffff) !== complement)
                    {
                        throw new InflateError('a stored length that is not its complement');
                    }
                    if (at + length > input.length)
                    {
                        throw new InflateError('a stored block past the input');
                    }
                    for (let i = 0; i < length; i++)
                    {
                        emit(input[at + i]);
                    }
                    at += length;
                }
                else if (type === 1)
                {
                    codes(FIXED.literal, FIXED.distance);
                }
                else if (type === 2)
                {
                    dynamic();
                }
                else
                {
                    throw new InflateError('block type 3 is reserved');
                }
            }
            return out.slice(0, written);
        },
    };
}

/**
 * One MSZIP data block: the `CK` signature, then a deflate stream.
 *
 * @param {ReturnType<typeof createInflater>} inflater
 * @param {Uint8Array} block @param {number} expected
 */
export function inflateMszipBlock(inflater, block, expected){
    if (block.length < 2 || block[0] !== 0x43 || block[1] !== 0x4b)
    {
        throw new InflateError('an MSZIP block without its CK signature');
    }
    const out = inflater.inflate(block.subarray(2), expected);
    if (out.length !== expected)
    {
        throw new InflateError(`an MSZIP block of ${out.length} bytes, not ${expected}`);
    }
    return out;
}
