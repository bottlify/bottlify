/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIECE_SIZE, bytesOf, createMemoryStore } from './memory-store.js';

const bytes = Uint8Array.from([1, 2, 3]);

test('a seed creates the directories its paths imply', ()=>{
    const store = createMemoryStore({ 'Game\\Data\\Config.WTF': 'x', 'Empty': null });

    assert.deepEqual(store.stat('Game'), { directory: true, size: 0 });
    assert.deepEqual(store.stat('Game\\Data'), { directory: true, size: 0 });
    assert.deepEqual(store.stat('Game\\Data\\Config.WTF'), { directory: false, size: 1 });
    assert.deepEqual(store.stat('Empty'), { directory: true, size: 0 });
    assert.equal(store.stat('game'), null, 'the store is a plain key/value map, case and all');
    assert.equal(store.list().length, 4);
});

test('a write past the end grows the file with zeroes', ()=>{
    const store = createMemoryStore({ 'a.dat': '' });

    store.write('a.dat', 4, bytes);

    assert.equal(store.stat('a.dat')?.size, 7);
    assert.deepEqual([...store.read('a.dat', 0, 7)], [0, 0, 0, 0, 1, 2, 3]);
});

test('a file appended to in small pieces is whole, and its size is what was written', ()=>{
    // An installer writes a file of hundreds of megabytes two kilobytes at a
    // time. The room kept spare for that must never show: the size and the
    // bytes are exactly what was written, growth or not, and a truncation
    // afterwards still answers from the written length.
    const store = createMemoryStore();
    const piece = new Uint8Array(1000);
    for (let index = 0; index < 100; index++)
    {
        piece.fill(index);
        store.write('big.dat', index * piece.length, piece);
    }
    assert.equal(store.stat('big.dat')?.size, 100 * piece.length);
    assert.deepEqual([...store.read('big.dat', 37 * piece.length - 1, 2)], [36, 37]);
    assert.deepEqual([...store.read('big.dat', 99 * piece.length + 999, 8)], [99]);

    store.write('big.dat', 50, Uint8Array.of(7));
    assert.deepEqual([...store.read('big.dat', 49, 3)], [0, 7, 0], 'a write inside stays inside');
    store.truncate('big.dat', 3);
    assert.equal(store.stat('big.dat')?.size, 3);
    assert.deepEqual([...store.read('big.dat', 0, 8)], [0, 0, 0]);
});

test('a file larger than a piece reads, writes and cuts across the pieces as one', ()=>{
    // Kept in pieces so that growing a file never copies what it holds; none
    // of that may show in what is read back.
    const store = createMemoryStore();
    const span = new Uint8Array(PIECE_SIZE + 10).map((_, at)=>at % 251);
    store.write('big.dat', PIECE_SIZE - 5, span);
    assert.equal(store.stat('big.dat')?.size, 2 * PIECE_SIZE + 5);
    assert.deepEqual([...store.read('big.dat', PIECE_SIZE - 7, 4)], [0, 0, 0, 1],
        'the gap before the first write is zeroes');
    assert.deepEqual([...store.read('big.dat', 2 * PIECE_SIZE - 2, 8)],
        [...span.subarray(PIECE_SIZE + 3)], 'and the bytes run on over a piece\'s edge');

    store.write('big.dat', 5 * PIECE_SIZE, bytes);
    assert.deepEqual([...store.read('big.dat', 3 * PIECE_SIZE, 3)], [0, 0, 0],
        'a piece never written is zeroes');
    assert.deepEqual([...store.read('big.dat', 5 * PIECE_SIZE, 8)], [1, 2, 3]);

    store.truncate('big.dat', PIECE_SIZE + 2);
    store.truncate('big.dat', 6 * PIECE_SIZE);
    assert.deepEqual([...store.read('big.dat', PIECE_SIZE, 4)], [...span.subarray(5, 7), 0, 0],
        'what a cut took is zeroes when the file grows again');
    assert.deepEqual([...store.read('big.dat', 5 * PIECE_SIZE, 3)], [0, 0, 0]);
});

test('a small file\'s piece grows as it does, a large file\'s next pieces are whole at once', ()=>{
    const store = createMemoryStore();
    const chunk = new Uint8Array(32768).fill(3);
    for (let at = 0; at < PIECE_SIZE + chunk.length; at += chunk.length)
    {
        store.write('big.dat', at, chunk);
    }
    store.write('small.dat', 0, chunk);
    const lengths = (/** @type {string} */ path)=>store.contents?.(path)?.pieces
        ?.map(piece=>piece?.length);
    assert.deepEqual(lengths('small.dat'), [32768], 'no more than the file needs');
    assert.deepEqual(lengths('big.dat'), [PIECE_SIZE, PIECE_SIZE],
        'the second piece made whole by its first write');
    assert.deepEqual([...store.read('big.dat', PIECE_SIZE + chunk.length - 1, 2)], [3]);
});

test('shared bytes stay as they were handed out, whatever is written after', ()=>{
    const store = createMemoryStore();
    store.write('a.dat', 0, new Uint8Array(PIECE_SIZE + 1).fill(4));
    const shared = store.share?.('a.dat') ?? new Uint8Array(0);
    assert.equal(shared.length, PIECE_SIZE + 1);
    assert.equal(store.share?.('a.dat'), shared, 'shared twice is the same bytes');
    store.write('a.dat', PIECE_SIZE, Uint8Array.of(9));
    assert.equal(shared[PIECE_SIZE], 4, 'the copy handed out is not written into');
    assert.deepEqual([...store.read('a.dat', PIECE_SIZE - 1, 2)], [4, 9]);

    const given = new Uint8Array(10).fill(1);
    store.adopt?.('b.dat', given);
    store.truncate('b.dat', 4);
    store.write('b.dat', 0, Uint8Array.of(2));
    assert.deepEqual([...given], new Array(10).fill(1), 'nor are adopted bytes');
    assert.deepEqual([...store.read('b.dat', 0, 8)], [2, 1, 1, 1]);
});

test('contents handed to another store are its pieces, and neither sees the other\'s writes', ()=>{
    // A child process's volume begins as its parent's: gigabytes an installer
    // laid down are not copied for the program it starts, and what either
    // writes afterwards is its own.
    const parent = createMemoryStore({ 'dir': null });
    const child = createMemoryStore({ 'dir': null });
    parent.write('dir\\big.gcf', 0, new Uint8Array(2 * PIECE_SIZE + 3).fill(5));
    const contents = parent.contents?.('dir\\big.gcf');
    assert.ok(contents && !contents.flat && contents.pieces.length === 3);
    child.adoptContents?.('dir\\big.gcf', contents);
    assert.deepEqual(child.stat('dir\\big.gcf'), { directory: false, size: 2 * PIECE_SIZE + 3 });

    child.write('dir\\big.gcf', 1, Uint8Array.of(7));
    parent.write('dir\\big.gcf', PIECE_SIZE + 1, Uint8Array.of(8));
    assert.deepEqual([...child.read('dir\\big.gcf', 0, 3)], [5, 7, 5]);
    assert.deepEqual([...parent.read('dir\\big.gcf', 0, 3)], [5, 5, 5],
        'the child\'s write stays the child\'s');
    assert.deepEqual([...child.read('dir\\big.gcf', PIECE_SIZE, 3)], [5, 5, 5],
        'and the parent\'s the parent\'s');
    child.truncate('dir\\big.gcf', 2 * PIECE_SIZE + 1);
    assert.equal(parent.read('dir\\big.gcf', 2 * PIECE_SIZE + 2, 1)[0], 5, 'a cut too');
    assert.equal(bytesOf(contents)[1], 5, 'and what was handed out is as it was');
    assert.equal(bytesOf(contents).length, 2 * PIECE_SIZE + 3);
});

test('a read is clamped to what is there rather than failing', ()=>{
    const store = createMemoryStore();
    store.write('a.dat', 0, bytes);

    assert.deepEqual([...store.read('a.dat', 1, 100)], [2, 3]);
    assert.deepEqual([...store.read('a.dat', 99, 4)], []);
    assert.throws(()=>store.read('missing', 0, 1), { code: 'NOT_FOUND' });
});

test('truncation cuts and extends from the same call', ()=>{
    const store = createMemoryStore();
    store.write('a.dat', 0, bytes);

    store.truncate('a.dat', 2);
    assert.deepEqual([...store.read('a.dat', 0, 8)], [1, 2]);
    store.truncate('a.dat', 4);
    assert.deepEqual([...store.read('a.dat', 0, 8)], [1, 2, 0, 0]);
});

test('the store never invents a directory it was not told about', ()=>{
    const store = createMemoryStore();

    assert.throws(()=>store.write('Save\\slot.dat', 0, bytes), { code: 'PATH_NOT_FOUND' });
    store.mkdir('Save');
    store.write('Save\\slot.dat', 0, bytes);
    assert.equal(store.stat('Save\\slot.dat')?.size, 3);

    assert.throws(()=>store.mkdir('Save'), { code: 'ALREADY_EXISTS' });
    assert.throws(()=>store.remove('Save\\missing'), { code: 'NOT_FOUND' });
    assert.throws(()=>store.write('Save', 0, bytes), { code: 'IS_A_DIRECTORY' });
});
