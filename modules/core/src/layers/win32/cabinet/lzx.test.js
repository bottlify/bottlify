/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The LZX decoder against streams built by the small encoder in
 * `lzx.fixture.js`: a cabinet's frames, and LZXD's chunks over a reference.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_SIZE, LzxError, createLzxDecoder, decodeLzxd, positionSlots } from './lzx.js';
import { encoder as slotEncoder, literals, lzxdStream, text, writer } from './lzx.fixture.js';

/** An encoder for a cabinet window of `2^bits` bytes. @param {number} bits */
const encoder = bits=>slotEncoder(positionSlots(bits));

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

/** The position slots of an LZXD window of 128 KiB, the smallest it has. */
const LZXD_SLOTS = positionSlots(17);

/** @param {string} value */
const ascii = value=>Uint8Array.from([...value].map(c=>c.charCodeAt(0)));

/**
 * One chunk of LZXD: no CALL translation, then one verbatim block of the
 * tokens given.
 *
 * @param {import('./lzx.fixture.js').Token[]} tokens @param {number} size
 */
const oneChunk = (tokens, size)=>{
    const w = writer();
    w.bits(0, 1);
    encoder17().block(w, 1, size, tokens)(w, tokens);
    return lzxdStream([w.done()]);
};
const encoder17 = ()=>slotEncoder(LZXD_SLOTS, { delta: true });

test('LZXD windows reach 32 MiB, with up to 290 position slots', ()=>{
    assert.deepEqual([22, 23, 24, 25].map(positionSlots), [66, 98, 162, 290]);
});

test('an LZXD match reaches back into the reference before the output', ()=>{
    const reference = ascii('the quick brown fox ');
    // "quick " from 16 back, "fox" from 10 back, then "x qu" across the
    // reference's end into the output's own first bytes.
    const tokens = [{ length: 6, offset: 16 }, { length: 3, offset: 10 },
        ...literals('!'), { length: 4, offset: 12 }];
    const out = decodeLzxd(oneChunk(tokens, 14), reference, 14);
    assert.equal(text(out), 'quick fox!x qu');
});

test('what a match reaches before the reference reads as zeros', ()=>{
    const out = decodeLzxd(oneChunk([{ length: 12, offset: 10 }], 12), ascii('abc'), 12);
    assert.deepEqual([...out], [0, 0, 0, 0, 0, 0, 0, 0x61, 0x62, 0x63, 0, 0]);
});

test('with no reference, the output is its own window', ()=>{
    const tokens = [...literals('ab'), { length: 10, offset: 2 }];
    assert.equal(text(decodeLzxd(oneChunk(tokens, 12), new Uint8Array(0), 12)), 'abababababab');
});

test('a match of the longest length is lengthened by one of four prefixed codes', ()=>{
    const reference = Uint8Array.from({ length: 300 }, (_, i)=>(i * 31 + 7) & 0xff);
    const lengths = [257 + 5, 257 + 0x100 + 3, 257 + 0x500 + 7, 257 + 0x1600];
    const tokens = lengths.map(length=>({ length, offset: 300 }));
    const size = lengths.reduce((sum, length)=>sum + length, 0);
    const out = decodeLzxd(oneChunk(tokens, size), reference, size);
    const expected = new Uint8Array(300 + size);
    expected.set(reference);
    for (let i = 300; i < expected.length; i++)
    {
        expected[i] = expected[i - 300];
    }
    assert.deepEqual(out, expected.subarray(300));
});

/**
 * An uncompressed block whose header ends on a word boundary, behind a
 * verbatim block of one repeated literal sized to put it there.
 *
 * @param {boolean} padAligned
 */
const alignedUncompressed = padAligned=>{
    for (let count = 1; count < 40; count++)
    {
        const w = writer();
        w.bits(0, 1);
        const tokens = literals('x'.repeat(count));
        encoder17().block(w, 1, count, tokens)(w, tokens);
        w.bits(3, 3);
        w.bits(4, 24);
        if (w.pending !== 0)
        {
            continue;
        }
        w.raw([3, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, ...ascii('abcd')], { padAligned });
        return { stream: lzxdStream([w.done()]), size: count + 4, count };
    }
    throw new Error('no literal count puts the header on a boundary');
};

test('an LZXD uncompressed block on a word boundary: a zero word is padding, else an offset', ()=>{
    for (const padAligned of [true, false])
    {
        const { stream, size, count } = alignedUncompressed(padAligned);
        assert.equal(text(decodeLzxd(stream, new Uint8Array(0), size)),
            `${'x'.repeat(count)}abcd`, `padded: ${padAligned}`);
    }
});

test('a block, a match and an uncompressed run go on from one chunk into the next', ()=>{
    const reference = Uint8Array.from({ length: 1000 }, (_, i)=>(i * 7) & 0xff);
    // Chunk one: 32763 literals, then a match of ten that ends five bytes into
    // the second chunk's output; chunk two: the rest of the block.
    const head = Array.from({ length: FRAME_SIZE - 5 }, (_, i)=>({ literal: (i * 13) & 0xff }));
    const crossing = { length: 10, offset: FRAME_SIZE + 500 };
    const tail = [...literals('end'), { length: 20, offset: 40000 }];
    const size = FRAME_SIZE - 5 + 10 + 3 + 20;
    const enc = encoder17();
    const one = writer();
    one.bits(0, 1);
    const write = enc.block(one, 1, size, [...head, crossing, ...tail]);
    write(one, [...head, crossing]);
    const two = writer();
    write(two, tail);
    const out = decodeLzxd(lzxdStream([one.done(), two.done()]), reference, size);

    const expected = new Uint8Array(1000 + size);
    expected.set(reference);
    let at = 1000;
    for (const token of [...head, crossing, ...tail])
    {
        if ('literal' in token)
        {
            expected[at++] = token.literal;
            continue;
        }
        for (let i = 0; i < token.length; i++, at++)
        {
            expected[at] = expected[at - /** @type {number} */ (token.offset)];
        }
    }
    assert.deepEqual(out, expected.subarray(1000));

    // An uncompressed block of a chunk and a hundred bytes: the raw bytes
    // run on into the second chunk, which then carries a verbatim block.
    const raw = Array.from({ length: FRAME_SIZE + 100 }, (_, i)=>(i * 5 + 1) & 0xff);
    const first = writer();
    first.bits(0, 1);
    first.bits(3, 3);
    first.bits(raw.length, 24);
    first.raw([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, ...raw.slice(0, FRAME_SIZE)]);
    const second = writer();
    second.bytes(raw.slice(FRAME_SIZE));
    const after = literals('ok');
    encoder17().block(second, 1, 2, after)(second, after);
    const decoded = decodeLzxd(lzxdStream([first.done(), second.done()]), new Uint8Array(0),
        raw.length + 2);
    assert.deepEqual([...decoded.subarray(0, raw.length)], raw);
    assert.equal(text(decoded.subarray(raw.length)), 'ok');
});

test('LZXD CALL translation is undone relative to the output, not the reference', ()=>{
    const bytes = new Uint8Array(64).fill(0x90);
    bytes[8] = 0xe8;
    new DataView(bytes.buffer).setInt32(9, 0x30, true);
    const w = writer();
    w.bits(1, 1);
    w.bits(0, 16);
    w.bits(0x1000, 16);
    const tokens = [...bytes].map(literal=>({ literal }));
    encoder17().block(w, 1, 64, tokens)(w, tokens);
    const out = decodeLzxd(lzxdStream([w.done()]), new Uint8Array(500), 64);
    assert.equal(new DataView(out.buffer, out.byteOffset).getInt32(9, true), 0x30 - 8);
});

test('a truncated LZXD stream, a zero repeated offset or bits past a chunk are errors', ()=>{
    const good = oneChunk(literals('hello'), 5);
    assert.throws(()=>decodeLzxd(good.subarray(0, good.length - 1), new Uint8Array(0), 5),
        LzxError, 'a chunk longer than the stream');
    assert.throws(()=>decodeLzxd(good, new Uint8Array(0), 6), LzxError,
        'output asked for past the stream');

    const w = writer();
    w.bits(0, 1);
    w.bits(3, 3);
    w.bits(2, 24);
    w.raw([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0x61, 0x62]);
    assert.throws(()=>decodeLzxd(lzxdStream([w.done()]), new Uint8Array(0), 2), LzxError);

    // A block of ten literals whose chunk is cut to its first word: the
    // decoder would have to read the padding as the rest.
    const cut = oneChunk(literals('abcdefghij'), 10);
    const short = lzxdStream([cut.subarray(2, 6)]);
    assert.throws(()=>decodeLzxd(short, new Uint8Array(0), 10), LzxError);
});
