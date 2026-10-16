/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { atPath, blocksOf, chunkedFile, sha256Blocks, sizeOf } from './chunks.js';
import { packBundle } from './pack.js';

const PIECE = 1 << 20;

/** A file of 3.01 MiB in the volume's pieces, the second never written. */
function sample(){
    const data = Uint8Array.from({ length: 3 * PIECE + 12345 }, (_, at)=>at * 7 + 3);
    const pieces = [];
    for (let at = 0; at < data.length; at += PIECE)
    {
        const piece = new Uint8Array(PIECE);
        piece.set(data.subarray(at, at + PIECE));
        pieces.push(piece);
    }
    pieces[1] = null;
    data.fill(0, PIECE, 2 * PIECE);
    return { data, pieces };
}

test('a file of pieces is read in blocks across their seams, a missing one as zeros', ()=>{
    // A game's 1.5 GB archive file, glued whole to cross to the page and
    // again to be hashed, was an allocation the tab could not make.
    const { data, pieces } = sample();
    const file = chunkedFile('C:\\Game\\bigfile.000', data.length, pieces);
    for (const size of [1 << 18, 250000, PIECE, 5 * PIECE])
    {
        const blocks = [...blocksOf(file, size)];
        assert.equal(blocks.reduce((sum, block)=>sum + block.length, 0), data.length);
        assert.deepEqual(Buffer.concat(blocks), Buffer.from(data), `blocks of ${size}`);
    }
    const first = blocksOf(file, 1 << 18).next().value;
    assert.equal(first?.buffer, pieces[0]?.buffer, 'a block inside one piece is a view of it');
    assert.equal(sizeOf(file), data.length);
    assert.deepEqual(Buffer.from(file.bytes), Buffer.from(data), 'whole when asked for');
    const moved = atPath(file, 'Game\\bigfile.000');
    assert.equal(moved.path, 'Game\\bigfile.000');
    assert.equal(moved.pieces, pieces, 'the same pieces, not copied');
    assert.ok(!Object.keys(moved).includes('bytes'), 'and no whole copy carried along');
});

test('SHA-256 over blocks as they come is SHA-256', ()=>{
    const { data, pieces } = sample();
    const file = chunkedFile('x', data.length, pieces);
    assert.equal(sha256Blocks(blocksOf(file, 1 << 18)),
        createHash('sha256').update(data).digest('hex'));
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000])
    {
        const bytes = Uint8Array.from({ length }, (_, at)=>at * 13);
        assert.equal(sha256Blocks([bytes.subarray(0, length >> 1), bytes.subarray(length >> 1)]),
            createHash('sha256').update(bytes).digest('hex'), `${length} bytes in two`);
    }
});

test('a bottle packed from pieces is the bottle packed from the whole file', async()=>{
    const { data, pieces } = sample();
    /** @param {any} files */
    const pack = async files=>{
        /** @type {Uint8Array[]} */
        const written = [];
        const summary = await packBundle({ files, write: async bytes=>{
            written.push(bytes.slice());
        } });
        return { written: Buffer.concat(written), index: Buffer.from(summary.index) };
    };
    const whole = await pack([{ path: 'big', bytes: data }]);
    const chunked = await pack([chunkedFile('big', data.length, pieces)]);
    assert.deepEqual(chunked.written, whole.written, 'the same blocks');
    assert.deepEqual(chunked.index, whole.index, 'and the same index, hashes and all');
});
