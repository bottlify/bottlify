/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIECE_SIZE, createMemoryStore } from './memory-store.js';
import { createOverlay } from './tree.js';
import { createUnionSource } from './union-source.js';
import { SESSION_LAYER, createSessionSource } from './session-source.js';

/**
 * A session's files as a store hands them out lazily, every read counted.
 *
 * @param {Record<string, Uint8Array>} contents  by path relative to the drive's root
 */
function lazySession(contents){
    /** @type {{ path: string, offset: number, length: number }[]} */
    const reads = [];
    const files = Object.entries(contents).map(([path, bytes])=>({
        path,
        file: {
            path: `C:\\${path}`,
            size: bytes.length,
            modified: 1234,
            /** @param {number} [offset] @param {number} [length] */
            read: async(offset = 0, length = bytes.length - offset)=>{
                reads.push({ path, offset, length });
                return bytes.slice(offset, offset + length);
            },
        },
    }));
    return { files, reads };
}

/** @param {number} size @param {number} seed */
const pattern = (size, seed)=>new Uint8Array(size).map((unused, at)=>(at * 31 + seed) & 0xff);

/**
 * An operation done again after each miss, its pieces fetched, as a caller
 * that can wait does it (`vfs.js`).
 *
 * @template T
 * @param {() => T} operation @param {any} session
 * @returns {Promise<{ result: T, misses: number }>}
 */
async function fetchedAgain(operation, session){
    for (let misses = 0; ; misses++)
    {
        try
        {
            return { result: operation(), misses };
        }
        catch (e){
            const miss = /** @type {any} */ (e);
            if (miss?.code !== 'BLOCK_MISS' || misses > 1000)
            {
                throw miss;
            }
            assert.ok(miss.blocks.every((/** @type {any} */ block)=>block.layer === SESSION_LAYER));
            await session.fetch(miss.blocks);
        }
    }
}

test('a session is listed whole and nothing of it is read until a read asks', async()=>{
    const { files, reads } = lazySession({
        'save.dat': pattern(10, 1),
        'Data\\big.pak': pattern(2 * PIECE_SIZE + 5, 2),
    });
    const session = createSessionSource(files);

    assert.deepEqual(session.list().map(entry=>[entry.path, entry.size, entry.modified]),
        [['save.dat', 10, 1234], ['Data\\big.pak', 2 * PIECE_SIZE + 5, 1234]]);
    assert.deepEqual(session.stat('data'), { directory: true, size: 0 });
    assert.deepEqual(session.stat('DATA\\BIG.PAK'), { directory: false, size: 2 * PIECE_SIZE + 5 });
    assert.deepEqual(reads, [], 'listing reads nothing');

    // A range across the first two pieces: one miss naming both, one read of each.
    const start = PIECE_SIZE - 3;
    assert.throws(()=>session.read('Data\\big.pak', start, 10), (/** @type {any} */ e)=>
        e.code === 'BLOCK_MISS' && e.blocks.length === 2);
    const { result, misses } = await fetchedAgain(()=>session.read('Data\\big.pak', start, 10),
        session);
    assert.equal(misses, 1);
    assert.deepEqual(result, pattern(2 * PIECE_SIZE + 5, 2).subarray(start, start + 10));
    assert.deepEqual(reads, [{ path: 'Data\\big.pak', offset: 0, length: PIECE_SIZE },
        { path: 'Data\\big.pak', offset: PIECE_SIZE, length: PIECE_SIZE }],
    'the pieces the range covers, and nothing else of the session');
    assert.deepEqual(session.read('data\\big.pak', start, 10), result,
        'read again from what was kept');
    assert.deepEqual(session.read('save.dat', 20, 4), new Uint8Array(0), 'past the end is empty');
});

test('what is kept is bounded, the least recently read let go of first', async()=>{
    const { files, reads } = lazySession({ 'a.bin': pattern(3 * PIECE_SIZE, 3) });
    const session = createSessionSource(files, { residentBytes: 2 * PIECE_SIZE });
    for (const piece of [0, 1, 2])
    {
        await fetchedAgain(()=>session.read('a.bin', piece * PIECE_SIZE, 1), session);
    }
    assert.equal(session.held().sessionPieces, 2 * PIECE_SIZE);
    assert.equal(reads.length, 3);
    await fetchedAgain(()=>session.read('a.bin', 0, 1), session);
    assert.equal(reads.length, 4, 'the first piece was let go of and read again');
});

test('under a writable layer: a write copies the file up a piece at a time, a delete leaves'
    + ' a tombstone, and what was not touched is the session\'s own', async()=>{
    const big = pattern(5 * PIECE_SIZE + 7, 4);
    const { files } = lazySession({
        'Saves\\big.sav': big,
        'Saves\\small.sav': pattern(9, 5),
        'Saves\\gone.sav': pattern(9, 6),
        'config.ini': pattern(3, 7),
    });
    // Two pieces kept at once: a copy that began again at every miss would
    // never finish.
    const session = createSessionSource(files, { residentBytes: 2 * PIECE_SIZE });
    const bundle = createMemoryStore({ 'config.ini': 'bundle', 'game.exe': 'MZ' });
    const drive = createOverlay({ source: createUnionSource([session, bundle]),
        writable: createMemoryStore() });

    assert.deepEqual(drive.list(['Saves']).map(entry=>entry.name).sort(),
        ['big.sav', 'gone.sav', 'small.sav']);
    assert.equal(drive.stat(['config.ini'])?.size, 3, 'the session\'s over the bundle\'s');

    const { misses } = await fetchedAgain(()=>drive.write(['Saves', 'big.sav'],
        3 * PIECE_SIZE + 1, new Uint8Array([0xee])), session);
    assert.equal(misses, 6, 'a miss a piece, each copy going on where the last stopped');
    const expected = big.slice();
    expected[3 * PIECE_SIZE + 1] = 0xee;
    assert.deepEqual(drive.read(['Saves', 'big.sav'], 0, big.length), expected);

    drive.removeFile(['Saves', 'gone.sav']);
    assert.equal(drive.stat(['Saves', 'gone.sav']), null, 'deleted, not back from the session');

    assert.deepEqual(drive.writableFiles().map(file=>file.path), ['Saves\\big.sav']);
    assert.deepEqual(drive.keptFiles().map((/** @type {any} */ file)=>file.path).sort(),
        ['C:\\Saves\\small.sav', 'C:\\config.ini'],
        'the session\'s own files the program left alone, the bundle\'s never');
    assert.ok(drive.keptFiles().every(file=>files.some(one=>one.file === file)),
        'handed out as the session handed them in');
});
