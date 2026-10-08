/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A small LZX encoder for building test streams, following the Cabinet SDK's
 * format description and LZXD's additions to it: 16-bit little-endian words
 * read most significant bit first, canonical trees sent as pre-tree coded
 * deltas, and matches as a main-tree element, a length-tree element, a
 * position footer and, in LZXD, a further length for the longest matches.
 */

/** Position footer bits per slot, from the format's position slot table. */
const EXTRA = Array.from({ length: 290 },
    (_, slot)=>(slot < 4 ? 0 : Math.min(17, (slot >> 1) - 1)));
const BASE = EXTRA.reduce((bases, bits, slot)=>
    [...bases, slot === 0 ? 0 : bases[slot - 1] + 2 ** EXTRA[slot - 1]], /** @type {number[]} */ ([]));

/** Bits as LZX packs them: into 16-bit words, most significant bit first. */
export function writer(){
    /** @type {number[]} */
    const out = [];
    let word = 0;
    let count = 0;
    /** @param {number} value @param {number} n */
    const bits = (value, n)=>{
        for (let i = n - 1; i >= 0; i--)
        {
            word = (word << 1) | (Math.floor(value / 2 ** i) & 1);
            if (++count === 16)
            {
                out.push(word & 0xff, word >> 8);
                word = 0;
                count = 0;
            }
        }
    };
    return {
        bits,
        /** Bits written into the word not yet complete. */
        get pending(){
            return count;
        },
        /**
         * The 1-16 bits of padding before raw bytes, then the bytes
         * themselves and a pad byte after an odd count. `padAligned: false`
         * writes no padding when already on a boundary, as the Patch API's
         * compressor may.
         *
         * @param {number[]} values @param {{ padAligned?: boolean }} [options]
         */
        raw(values, { padAligned = true } = {}){
            if (count !== 0 || padAligned)
            {
                bits(0, 16 - count);
            }
            for (const value of values)
            {
                out.push(value);
            }
            if (values.length & 1)
            {
                out.push(0);
            }
        },
        /** Bytes as they are, with no alignment: the rest of a raw run. @param {number[]} values */
        bytes(values){
            for (const value of values)
            {
                out.push(value);
            }
        },
        /** A frame or chunk ends on a 16-bit boundary. */
        done(){
            if (count)
            {
                bits(0, 16 - count);
            }
            return Uint8Array.from(out);
        },
    };
}

/**
 * Path lengths for the symbols given, from their counts: a plain Huffman
 * merge, with a second symbol added when only one is used.
 *
 * @param {number} size @param {Map<number, number>} counts
 */
function lengthsFor(size, counts){
    const used = [...counts.keys()];
    if (used.length === 1)
    {
        counts.set(used[0] === 0 ? 1 : 0, 1);
    }
    /** @type {{ weight: number, symbols: number[] }[]} */
    let nodes = [...counts].map(([symbol, weight])=>({ weight, symbols: [symbol] }));
    const lengths = new Uint8Array(size);
    while (nodes.length > 1)
    {
        nodes.sort((a, b)=>a.weight - b.weight);
        const [a, b] = nodes;
        for (const symbol of [...a.symbols, ...b.symbols])
        {
            lengths[symbol]++;
        }
        nodes = [{ weight: a.weight + b.weight, symbols: [...a.symbols, ...b.symbols] },
            ...nodes.slice(2)];
    }
    return lengths;
}

/**
 * Canonical codes: shorter first, and within a length by symbol.
 *
 * @param {Uint8Array} lengths
 * @returns {Map<number, { code: number, length: number }>}
 */
function canonical(lengths){
    const order = [...lengths.keys()].filter(s=>lengths[s] > 0)
        .sort((a, b)=>lengths[a] - lengths[b] || a - b);
    const codes = new Map();
    let code = 0;
    let previous = 0;
    for (const symbol of order)
    {
        code <<= lengths[symbol] - previous;
        previous = lengths[symbol];
        codes.set(symbol, { code, length: lengths[symbol] });
        code++;
    }
    return codes;
}

/**
 * One tree code as sent: a delta or run code, the extra bits some carry, and
 * the delta that follows a 19.
 *
 * @typedef {{ code: number, extra?: number, bits?: number, delta?: number }} Step
 */

/**
 * What a token is sent as.
 *
 * @typedef {{ main: number, footerLength?: number | null, verbatim?: number,
 *     verbatimBits?: number, aligned?: number, longer?: number }} Shaped
 */

/**
 * Sends `lengths[first..last)` as deltas from `previous`, through a
 * pre-tree. `plan` may give explicit tree codes (17, 18, 19 runs) instead of
 * one delta per element.
 *
 * @param {ReturnType<typeof writer>} w
 * @param {Uint8Array} previous @param {Uint8Array} lengths
 * @param {number} first @param {number} last
 * @param {Step[]} [plan]
 */
function sendLengths(w, previous, lengths, first, last, plan){
    /** @type {Step[]} */
    const steps = plan ?? [...lengths.subarray(first, last)].map((length, i)=>
        ({ code: (previous[first + i] - length + 17) % 17 }));
    const counts = new Map();
    for (const step of steps)
    {
        counts.set(step.code, (counts.get(step.code) ?? 0) + 1);
        if (step.delta !== undefined)
        {
            counts.set(step.delta, (counts.get(step.delta) ?? 0) + 1);
        }
    }
    const pre = lengthsFor(20, counts);
    for (let i = 0; i < 20; i++)
    {
        w.bits(pre[i], 4);
    }
    const codes = canonical(pre);
    /** @param {number} symbol */
    const put = symbol=>{
        const entry = /** @type {{ code: number, length: number }} */ (codes.get(symbol));
        w.bits(entry.code, entry.length);
    };
    for (const step of steps)
    {
        put(step.code);
        if (step.bits !== undefined)
        {
            w.bits(/** @type {number} */ (step.extra), step.bits);
        }
        if (step.delta !== undefined)
        {
            put(step.delta);
        }
    }
    previous.set(lengths.subarray(first, last), first);
}

/**
 * @typedef {{ literal: number } | { length: number, offset?: number, repeat?: number }} Token
 */

/**
 * The extra length LZXD sends after a match of 257 or more: a one- to
 * three-bit prefix choosing how many bits follow.
 *
 * @param {ReturnType<typeof writer>} w @param {number} extra  The length past 257.
 */
function sendLonger(w, extra){
    if (extra < 0x100)
    {
        w.bits(0, 1);
        w.bits(extra, 8);
    }
    else if (extra < 0x500)
    {
        w.bits(0b10, 2);
        w.bits(extra - 0x100, 10);
    }
    else if (extra < 0x1500)
    {
        w.bits(0b110, 3);
        w.bits(extra - 0x500, 12);
    }
    else
    {
        w.bits(0b111, 3);
        w.bits(extra, 15);
    }
}

/**
 * An encoder holding what the decoder holds across blocks: the previous
 * trees, to send deltas against.
 *
 * @param {number} slots  Position slots of the window the stream is for.
 * @param {{ delta?: boolean }} [options]  LZXD: matches longer than 257.
 */
export function encoder(slots, { delta = false } = {}){
    const mainElements = 256 + slots * 8;
    const previousMain = new Uint8Array(mainElements);
    const previousLength = new Uint8Array(249);

    /** @param {Token} token @param {boolean} aligned @returns {Shaped} */
    const shape = (token, aligned)=>{
        if ('literal' in token)
        {
            return { main: token.literal };
        }
        const header = token.length <= 8 ? token.length - 2 : 7;
        const footerLength = token.length <= 8 ? null : Math.min(token.length, 257) - 9;
        const longer = delta && token.length >= 257 ? token.length - 257 : undefined;
        if (token.repeat !== undefined)
        {
            return { main: 256 + token.repeat * 8 + header, footerLength, longer };
        }
        const formatted = /** @type {number} */ (token.offset) + 2;
        let slot = 3;
        while (slot + 1 < slots && BASE[slot + 1] <= formatted)
        {
            slot++;
        }
        const footer = formatted - BASE[slot];
        const extra = EXTRA[slot];
        return {
            main: 256 + slot * 8 + header, footerLength, longer,
            ...aligned && extra >= 3
                ? { verbatim: footer >> 3, verbatimBits: extra - 3, aligned: footer & 7 }
                : { verbatim: footer, verbatimBits: extra },
        };
    };

    return {
        /**
         * Starts a verbatim or aligned block: its header and trees, sized
         * for the tokens it will carry, and a function that writes tokens.
         *
         * @param {ReturnType<typeof writer>} w
         * @param {1 | 2} type @param {number} size @param {Token[]} tokens
         * @param {{ mainPlan?: any[], lengthPlan?: any[] }} [plans]
         */
        block(w, type, size, tokens, plans = {}){
            const shaped = tokens.map(token=>shape(token, type === 2));
            const mainCounts = new Map();
            const lengthCounts = new Map([[0, 1]]);
            const alignedCounts = new Map([[0, 1]]);
            for (const s of shaped)
            {
                mainCounts.set(s.main, (mainCounts.get(s.main) ?? 0) + 1);
                if (s.footerLength != null)
                {
                    lengthCounts.set(s.footerLength, (lengthCounts.get(s.footerLength) ?? 0) + 1);
                }
                if (s.aligned !== undefined)
                {
                    alignedCounts.set(s.aligned, (alignedCounts.get(s.aligned) ?? 0) + 1);
                }
            }
            const main = lengthsFor(mainElements, mainCounts);
            const length = lengthsFor(249, lengthCounts);
            const alignedLengths = lengthsFor(8, alignedCounts);
            w.bits(type, 3);
            w.bits(size, 24);
            if (type === 2)
            {
                for (let i = 0; i < 8; i++)
                {
                    w.bits(alignedLengths[i], 3);
                }
            }
            sendLengths(w, previousMain, main, 0, 256, plans.mainPlan);
            sendLengths(w, previousMain, main, 256, mainElements);
            sendLengths(w, previousLength, length, 0, 249, plans.lengthPlan);
            const mainCodes = canonical(main);
            const lengthCodes = canonical(length);
            const alignedCodes = canonical(alignedLengths);
            /** @param {ReturnType<typeof writer>} into @param {Token[]} some */
            return (into, some)=>{
                for (const token of some)
                {
                    const s = shape(token, type === 2);
                    const m = /** @type {any} */ (mainCodes.get(s.main));
                    into.bits(m.code, m.length);
                    if (s.footerLength != null)
                    {
                        const l = /** @type {any} */ (lengthCodes.get(s.footerLength));
                        into.bits(l.code, l.length);
                    }
                    if (s.verbatimBits)
                    {
                        into.bits(/** @type {number} */ (s.verbatim), s.verbatimBits);
                    }
                    if (s.aligned !== undefined)
                    {
                        const a = /** @type {any} */ (alignedCodes.get(s.aligned));
                        into.bits(a.code, a.length);
                    }
                    if (s.longer !== undefined)
                    {
                        sendLonger(into, s.longer);
                    }
                }
            };
        },
    };
}

/**
 * An LZXD stream from its chunks' bits: each behind its 16-bit byte count.
 *
 * @param {Uint8Array[]} chunks
 */
export function lzxdStream(chunks){
    const out = new Uint8Array(chunks.reduce((sum, chunk)=>sum + 2 + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks)
    {
        out[at] = chunk.length & 0xff;
        out[at + 1] = chunk.length >> 8;
        out.set(chunk, at + 2);
        at += 2 + chunk.length;
    }
    return out;
}

/** @param {string} text */
export const literals = text=>[...text].map(c=>({ literal: c.charCodeAt(0) }));

/** @param {Uint8Array} bytes */
export const text = bytes=>String.fromCharCode(...bytes);
