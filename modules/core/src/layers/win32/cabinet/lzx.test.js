/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The LZX decoder against streams built here by a small encoder that
 * follows the Cabinet SDK's format description: 16-bit little-endian words
 * read most significant bit first, canonical trees sent as pre-tree coded
 * deltas, and matches as a main-tree element, a length-tree element and a
 * position footer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_SIZE, LzxError, createLzxDecoder, positionSlots } from './lzx.js';

/** Position footer bits per slot, from the format's position slot table. */
const EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, ...new Array(14).fill(17)];
const BASE = EXTRA.reduce((bases, bits, slot)=>
    [...bases, slot === 0 ? 0 : bases[slot - 1] + 2 ** EXTRA[slot - 1]], /** @type {number[]} */ ([]));

/** Bits as LZX packs them: into 16-bit words, most significant bit first. */
function writer(){
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
        /** The 1-16 bits of padding before raw bytes, then the bytes themselves. */
        raw(/** @type {number[]} */ values){
            bits(0, 16 - count);
            out.push(...values);
            if (values.length & 1)
            {
                out.push(0);
            }
        },
        /** A frame ends on a 16-bit boundary. */
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
 *     verbatimBits?: number, aligned?: number }} Shaped
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
 * An encoder holding what the decoder holds across blocks: the previous
 * trees, to send deltas against.
 *
 * @param {number} windowBits
 */
function encoder(windowBits){
    const mainElements = 256 + positionSlots(windowBits) * 8;
    const previousMain = new Uint8Array(mainElements);
    const previousLength = new Uint8Array(249);

    /** @param {Token} token @param {boolean} aligned @returns {Shaped} */
    const shape = (token, aligned)=>{
        if ('literal' in token)
        {
            return { main: token.literal };
        }
        const header = token.length <= 8 ? token.length - 2 : 7;
        const footerLength = token.length <= 8 ? null : token.length - 9;
        if (token.repeat !== undefined)
        {
            return { main: 256 + token.repeat * 8 + header, footerLength };
        }
        const formatted = /** @type {number} */ (token.offset) + 2;
        let slot = 3;
        while (BASE[slot + 1] <= formatted)
        {
            slot++;
        }
        const footer = formatted - BASE[slot];
        const extra = EXTRA[slot];
        return {
            main: 256 + slot * 8 + header, footerLength,
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
                }
            };
        },
    };
}

/** @param {string} text */
const literals = text=>[...text].map(c=>({ literal: c.charCodeAt(0) }));
/** @param {Uint8Array} bytes */
const text = bytes=>String.fromCharCode(...bytes);

test('the window sizes and their position slots', ()=>{
    assert.deepEqual([15, 16, 17, 18, 19, 20, 21].map(positionSlots),
        [30, 32, 34, 36, 38, 42, 50]);
    assert.throws(()=>createLzxDecoder(14), LzxError);
    assert.throws(()=>createLzxDecoder(22), LzxError);
});

test('a verbatim block of literals and matches, with no CALL translation', ()=>{
    const w = writer();
    w.bits(0, 1); // no E8 preprocessing
    const enc = encoder(15);
    const tokens = [...literals('abcd'), { length: 8, offset: 4 }, ...literals('XY'),
        { length: 20, offset: 14 }];
    const size = 4 + 8 + 2 + 20;
    enc.block(w, 1, size, tokens)(w, tokens);
    const out = createLzxDecoder(15).decodeFrame(w.done(), size);
    assert.equal(text(out), 'abcdabcdabcdXYabcdabcdabcdXYabcdab');
});

test('repeated offsets: slot 0 is R0, and slots 1 and 2 swap with it', ()=>{
    const w = writer();
    w.bits(0, 1);
    const enc = encoder(15);
    const tokens = [
        ...literals('0123456789'),
        { length: 2, offset: 10 }, // "01", R = 10,1,1
        { length: 2, offset: 5 }, //  "78", from 7; R = 5,10,1
        { length: 3, repeat: 1 }, //  R1 (10) at 14: "456"; R = 10,5,1
        { length: 2, repeat: 0 }, //  R0 (10) again: "78"
        { length: 2, repeat: 2 }, //  R2 (1): R = 1,5,10 -- one back, twice
    ];
    const size = 10 + 2 + 2 + 3 + 2 + 2;
    enc.block(w, 1, size, tokens)(w, tokens);
    const out = text(createLzxDecoder(15).decodeFrame(w.done(), size));
    // The literals, then "01", "78", "456", "78" and "88".
    const expected = '012345678901784567888';
    assert.equal(out, expected);
});

test('an aligned offset block takes a footer\'s low three bits from the aligned tree', ()=>{
    const w = writer();
    w.bits(0, 1);
    const enc = encoder(16);
    const prefix = Array.from({ length: 300 }, (_, i)=>({ literal: (i * 7) & 0xff }));
    // Offsets whose slots have 3, 4 and 8 footer bits, and one with fewer.
    const tokens = [...prefix, { length: 5, offset: 20 }, { length: 9, offset: 40 },
        { length: 30, offset: 290 }, { length: 3, offset: 7 }];
    const size = 300 + 5 + 9 + 30 + 3;
    enc.block(w, 2, size, tokens)(w, tokens);
    const out = createLzxDecoder(16).decodeFrame(w.done(), size);
    const expected = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < 300; i++)
    {
        expected[at++] = (i * 7) & 0xff;
    }
    for (const [length, offset] of [[5, 20], [9, 40], [30, 290], [3, 7]])
    {
        for (let i = 0; i < length; i++, at++)
        {
            expected[at] = expected[at - offset];
        }
    }
    assert.deepEqual(out, expected);
});

test('an uncompressed block sets the repeated offsets and hands its bytes through', ()=>{
    const w = writer();
    w.bits(0, 1);
    w.bits(3, 3);
    w.bits(5, 24);
    // R0 = 3, R1 = 2, R2 = 1, then five bytes: an odd count, so a pad byte.
    w.raw([3, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, ...[...'hello'].map(c=>c.charCodeAt(0))]);
    const enc = encoder(15);
    const tokens = [{ length: 3, repeat: 0 }, { length: 2, repeat: 1 }];
    enc.block(w, 1, 5, tokens)(w, tokens);
    const out = text(createLzxDecoder(15).decodeFrame(w.done(), 10));
    assert.equal(out, 'hellollolo', 'R0 three back, then R1 two back');
});

test('trees are sent as deltas from the block before, with runs of zeros and of a value', ()=>{
    const w = writer();
    w.bits(0, 1);
    const enc = encoder(15);
    const first = literals('ababab');
    enc.block(w, 1, 6, first)(w, first);
    // The second block's main tree gives 'c' and 'd' lengths of one; the
    // first 256 elements are sent as a run of 97 zeros (18: 20 + 31, 18: 20
    // + 26), four single deltas, and 155 zeros -- the last four through code
    // 19, four elements of one value.
    const second = literals('cdcd');
    const zero = /** @param {number} run */ run=>(run >= 20
        ? { code: 18, extra: run - 20, bits: 5 } : { code: 17, extra: run - 4, bits: 4 });
    // 'a' and 'b' had length 1 and fall to 0: a delta of 1 each, sent by
    // position through the runs around them.
    const mainPlan = [zero(51), zero(46), { code: 1 }, { code: 1 },
        { code: 17 - 1 }, { code: 17 - 1 }, zero(51), zero(51), zero(49),
        { code: 19, extra: 0, bits: 1, delta: 0 }];
    enc.block(w, 1, 4, second, { mainPlan })(w, second);
    const out = text(createLzxDecoder(15).decodeFrame(w.done(), 10));
    assert.equal(out, 'abababcdcd');
});

test('a block and the window carry from one frame to the next', ()=>{
    const enc = encoder(15);
    const frameOne = writer();
    frameOne.bits(0, 1);
    const pattern = Array.from({ length: FRAME_SIZE }, (_, i)=>({ literal: (i * 13) & 0xff }));
    const tail = [{ length: 100, offset: FRAME_SIZE - 5 }];
    const write = enc.block(frameOne, 1, FRAME_SIZE + 100, [...pattern, ...tail]);
    write(frameOne, pattern);
    const frameTwo = writer();
    write(frameTwo, tail);

    const decoder = createLzxDecoder(15);
    const one = decoder.decodeFrame(frameOne.done(), FRAME_SIZE);
    const two = decoder.decodeFrame(frameTwo.done(), 100);
    assert.equal(one[FRAME_SIZE - 1], ((FRAME_SIZE - 1) * 13) & 0xff);
    for (let i = 0; i < 100; i++)
    {
        assert.equal(two[i], one[5 + i], `byte ${i} reaches back into the frame before`);
    }
});

/**
 * One frame of the given bytes as literals, with CALL translation on.
 *
 * @param {Uint8Array} bytes @param {number} translation
 */
const translatedFrame = (bytes, translation)=>{
    const w = writer();
    w.bits(1, 1);
    w.bits(translation >>> 16, 16); // the high half first
    w.bits(translation & 0xffff, 16);
    const tokens = [...bytes].map(literal=>({ literal }));
    encoder(15).block(w, 1, bytes.length, tokens)(w, tokens);
    return createLzxDecoder(15).decodeFrame(w.done(), bytes.length);
};

/** @param {number} size @param {[number, number][]} calls */
const withCalls = (size, calls)=>{
    const bytes = new Uint8Array(size).fill(0x90);
    for (const [at, value] of calls)
    {
        bytes[at] = 0xe8;
        new DataView(bytes.buffer).setInt32(at + 1, value, true);
    }
    return bytes;
};

test('CALL targets are turned back from absolute to relative within the translation size', ()=>{
    const out = translatedFrame(withCalls(64, [
        [0, 0x10], //   absolute 0x10 at 0: relative 0x10
        [8, 0x20], //   at 8: 0x20 - 8
        [16, -4], //    negative, and no further back than the start: -4 + the size
        [24, 0x2000], // at or beyond the translation size: left as it is
        [32, -100], //  before the start of the folder: left as it is
    ]), 0x1000);
    const view = new DataView(out.buffer, out.byteOffset);
    assert.equal(view.getInt32(1, true), 0x10);
    assert.equal(view.getInt32(9, true), 0x20 - 8);
    assert.equal(view.getInt32(17, true), -4 + 0x1000);
    assert.equal(view.getInt32(25, true), 0x2000);
    assert.equal(view.getInt32(33, true), -100);
});

test('no CALL is translated into a frame\'s last six bytes', ()=>{
    const last = translatedFrame(withCalls(64, [[53, 0x40]]), 0x1000);
    assert.equal(new DataView(last.buffer).getInt32(54, true), 0x40 - 53,
        'five bytes ending just before the final six');
    const beyond = translatedFrame(withCalls(64, [[54, 0x40]]), 0x1000);
    assert.equal(new DataView(beyond.buffer).getInt32(55, true), 0x40);
});

test('an undefined block type, or a tree used with no elements, is an error', ()=>{
    const w = writer();
    w.bits(0, 1);
    w.bits(5, 3);
    w.bits(10, 24);
    assert.throws(()=>createLzxDecoder(15).decodeFrame(w.done(), 10), LzxError);

    const v = writer();
    v.bits(0, 1);
    const enc = encoder(15);
    // A length-tree element is needed for a match of 9 or more, and the
    // tree was built for a block of literals only: its one element is 0,
    // so a match of 9 decodes, but a frame that asks past the block fails.
    const tokens = literals('abc');
    enc.block(v, 1, 3, tokens)(v, tokens);
    assert.throws(()=>createLzxDecoder(15).decodeFrame(v.done(), 4), LzxError);
});
