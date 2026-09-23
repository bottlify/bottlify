/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The zstd decoder against frames Node's own encoder made: one for each
 * block type and literal encoding the format has, so a frame that decodes is
 * not proof that every path was walked. `zstdStats` is reset before the
 * coverage test and read after it, so each encoding must have occurred at
 * least once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decompressZstd, buildFseTable, zstdStats, resetZstdStats } from './zstd.js';

/**
 * @param {Uint8Array | Buffer} input @param {number} [level]
 * @param {number} [checksum]
 * @returns {Uint8Array}
 */
function compressed(input, level = 1, checksum = 0){
    return new Uint8Array(zlib.zstdCompressSync(input, {
        params: {
            [zlib.constants.ZSTD_c_compressionLevel]: level,
            [zlib.constants.ZSTD_c_checksumFlag]: checksum,
        },
    }));
}

/** @param {Uint8Array | Buffer} input @param {number} [level] */
function roundTrip(input, level = 1){
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const out = decompressZstd(compressed(bytes, level), bytes.length);
    assert.equal(out.length, bytes.length);
    assert.deepEqual([...out], [...bytes]);
    return out;
}

/** Deterministic noise no compressor can help with. @param {number} length */
function noise(length){
    const out = new Uint8Array(length);
    let state = 0x12345678;
    for (let at = 0; at < length; at++)
    {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        out[at] = (state >>> 16) & 0xff;
    }
    return out;
}

test('an empty frame', ()=>{
    const out = decompressZstd(compressed(new Uint8Array(0)), 0);
    assert.equal(out.length, 0);
});

test('a single byte', ()=>{
    roundTrip(new Uint8Array([0x42]));
});

test('4 KiB of one byte', ()=>{
    const out = roundTrip(new Uint8Array(4096).fill(0xaa));
    assert.ok(out.every(byte=>byte === 0xaa));
});

test('64 KiB of text decodes at every level', ()=>{
    const text = new TextEncoder().encode(
        'the quick brown fox jumps over the lazy dog. '.repeat(1500));
    for (const level of [1, 3, 6, 9, 12, 19])
    {
        roundTrip(text, level);
    }
});

test('1 MiB of noise is raw blocks', ()=>{
    roundTrip(noise(1 << 20), 1);
});

test('3 MiB spanning several blocks, with matches across block boundaries', ()=>{
    const big = new Uint8Array(3 << 20);
    for (let at = 0; at < big.length; at++)
    {
        big[at] = (at * 7 + (at >> 12)) & 0x3f;
    }
    roundTrip(big, 3);
});

test('a frame with a content checksum decodes, the checksum unverified', ()=>{
    const input = new Uint8Array(4096);
    for (let at = 0; at < input.length; at++)
    {
        input[at] = (at * 13) & 0xff;
    }
    const out = decompressZstd(compressed(input, 5, 1), input.length);
    assert.deepEqual([...out], [...input]);
});

test('a compressed block of RLE literals and no sequences', ()=>{
    // Hand-built, since the encoder here prefers an RLE block for a run:
    // magic, a single-segment descriptor with a one-byte content size, a
    // last compressed block of three RLE 'A' literals and zero sequences.
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x03,
        0x1d, 0x00, 0x00, 0x19, 0x41, 0x00]);
    resetZstdStats();
    const out = decompressZstd(frame, 3);
    assert.deepEqual([...out], [0x41, 0x41, 0x41]);
    assert.equal(zstdStats.rleLiterals, 1);
});

/** A ramp with a long period: many blocks, matches and FSE tables. @param {number} length */
function ramp(length){
    const out = new Uint8Array(length);
    for (let at = 0; at < length; at++)
    {
        out[at] = (at * 7 + (at >> 12)) & 0x3f;
    }
    return out;
}

test('every block and literal and table kind is walked at least once', ()=>{
    resetZstdStats();
    const text = new TextEncoder().encode(
        'the quick brown fox jumps over the lazy dog. '.repeat(1500));
    const noise1m = noise(1 << 20);
    // A block of mostly one byte with a rare other: a one-stream Huffman
    // literal section and the treeless blocks after it.
    const run = new Uint8Array(1 << 20).fill(0x55);
    for (let at = 4096; at < run.length; at += 4096)
    {
        run[at] = 0x00;
    }
    const cases = [
        [new Uint8Array(0), 1],
        [new Uint8Array([0x42]), 1],
        [new Uint8Array(1 << 20).fill(0xaa), 1],
        [noise1m, 1],
        [text, 1],
        [text, 6],
        [text, 12],
        [text, 19],
        [noise(1 << 20).map((byte, at)=>at % 7 === 0 ? 0 : byte), 12],
        [noise(256 * 1024).map(byte=>byte & 7), 19],
        [ramp(3 << 20), 9],
        [ramp(3 << 20), 19],
        [run, 1],
    ];
    for (const [input, level] of cases)
    {
        const bytes = /** @type {Uint8Array} */ (input);
        decompressZstd(compressed(bytes, /** @type {number} */ (level)), bytes.length);
    }
    decompressZstd(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x03,
        0x1d, 0x00, 0x00, 0x19, 0x41, 0x00]), 3);
    const missing = Object.entries(zstdStats)
        .filter(([, count])=>count === 0)
        .map(([name])=>name);
    assert.deepEqual(missing, [], `no frames used ${missing.join(', ')}`);
});

test('a frame that ends mid-block throws the short-frame error', ()=>{
    const packed = compressed(new Uint8Array(1024).fill(7));
    assert.throws(()=>decompressZstd(packed.subarray(0, 4), 0),
        /frame ended before it was supposed to/);
    assert.throws(()=>decompressZstd(packed.subarray(0, packed.length - 3), 1024),
        /frame ended before it was supposed to/);
});

test('a frame naming a dictionary is refused', ()=>{
    // magic, a descriptor with Single_Segment_flag and Dict_ID_flag 1, then
    // the one-byte dictionary id, the one-byte content size, and an empty
    // last raw block.
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x21, 0x01, 0x00,
        0x01, 0x00, 0x00]);
    assert.throws(()=>decompressZstd(frame, 0), /unsupported dictionary id/);
});

test('a frame claiming a window past 128 MiB is refused', ()=>{
    // descriptor: no content size, no single segment; the window descriptor
    // names the largest window (exponent 31).
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xf8,
        0x01, 0x00, 0x00]);
    assert.throws(()=>decompressZstd(frame, 0), /unsupported window/);
});

test('the FSE table matches the format\'s worked example (RFC 8878, Table 21)', ()=>{
    // One symbol with a probability of 5 in an accuracy-log-7 table: its
    // five cells, in table order, take states 5..9 and the baseline and bit
    // count of Table 21.
    const table = buildFseTable([5, 123], 7);
    const cells = table.map((cell, at)=>({ cell, at }))
        .filter(({ cell })=>cell.symbol === 0)
        .map(({ cell })=>({ numBits: cell.numBits, baseline: cell.baseline }));
    assert.deepEqual(cells.map(one=>one.numBits), [5, 5, 5, 4, 4]);
    assert.deepEqual(cells.map(one=>one.baseline), [32, 64, 96, 0, 16]);
});

test('an FSE table puts the "less than one" symbols at the end, one cell each', ()=>{
    // The format's smallest tables are accuracy-log 5; the -1 counts as one
    // point each, so [15, 15, -1, -1] fills a 32-cell table exactly.
    const table = buildFseTable([15, 15, -1, -1], 5);
    assert.equal(table.length, 32);
    assert.equal(table[31].symbol, 2);
    assert.equal(table[31].numBits, 5);
    assert.equal(table[31].baseline, 0);
    assert.equal(table[30].symbol, 3);
    assert.equal(table[30].numBits, 5);
    assert.equal(table[30].baseline, 0);
    assert.equal(table.filter(cell=>cell.symbol === 0).length, 15);
    assert.equal(table.filter(cell=>cell.symbol === 1).length, 15);
});

test('a tree whose last symbol carries the largest weight decodes', ()=>{
    // The implied last weight completes the power of two: when the highest
    // symbol is the most frequent its run is 4 or more, and the weight is the
    // run's log plus one, not the run itself -- a level-1 frame of a buffer
    // that is mostly 0xff read back wrong until this was so.
    const buffer = Buffer.alloc(200_000);
    for (let at = 0; at < buffer.length; at++)
    {
        const r = (Math.imul(at, 2654435761) >>> 0) % 100;
        buffer[at] = r < 80 ? 0xff : r < 90 ? 0x41 : r < 95 ? 0x42 : (r % 7) + 0x30;
    }
    for (const level of [1, 3, 19])
    {
        const packed = zlib.zstdCompressSync(buffer,
            { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
        assert.deepEqual(Buffer.from(decompressZstd(packed, buffer.length)), buffer,
            `level ${level}`);
    }
});
