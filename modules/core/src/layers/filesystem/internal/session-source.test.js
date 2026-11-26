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
import { createReader, openKeeper } from '@bottlify/cellar';

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

/**
 * A session source over a Cellar keeper (`@bottlify/cellar`) of `room` bytes,
 * as the run's cache keeps its pieces (`process/session.js`): a space of names
 * of its own, read in place, let go of for room. Closed when the test ends.
 *
 * @param {any} t @param {any[]} files @param {number} room
 */
async function sessionWithRoom(t, files, room){
    const keeper = await openKeeper({ budget: room, segmentBytes: room });
    t.after(()=>keeper.close());
    const reader = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options ?? {}),
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        } });
    return createSessionSource(files, { kept: {
        look: key=>reader.look(`session/${key}`),
        with: (key, read, options)=>reader.with(`session/${key}`, read, options),
        put: (key, bytes)=>reader.put(`session/${key}`, bytes, { disk: 'never' }),
    } });
}

test('the contract: a read answers the bytes or a miss naming every piece it lacks, a fetch'
    + ' reads exactly those, and a piece let go of is read from the session again', async t=>{
    const size = 3 * PIECE_SIZE + 11;
    const bytes = pattern(size, 3);
    const { files, reads } = lazySession({ 'a.bin': bytes, 'b.bin': pattern(7, 8) });
    const session = await sessionWithRoom(t, files, 2 * PIECE_SIZE);

    // A miss names each piece the range lacks, where it lies and how long it is,
    // and hands nothing.
    /** @type {any} */
    let miss = null;
    let handed = 0;
    try
    {
        session.readInto('a.bin', PIECE_SIZE + 5, 2 * PIECE_SIZE + 3, ()=>{
            handed++;
        });
    }
    catch (e){
        miss = e;
    }
    assert.equal(miss?.code, 'BLOCK_MISS');
    assert.equal(handed, 0, 'a miss hands nothing');
    assert.deepEqual(miss.blocks.map((/** @type {any} */ block)=>[block.layer, block.offset,
        block.packed]), [[SESSION_LAYER, PIECE_SIZE, PIECE_SIZE],
        [SESSION_LAYER, 2 * PIECE_SIZE, PIECE_SIZE], [SESSION_LAYER, 3 * PIECE_SIZE, 11]]);
    assert.equal(new Set(miss.blocks.map((/** @type {any} */ block)=>block.index)).size, 3);
    assert.deepEqual(reads, [], 'a miss reads nothing of the session');

    // The last piece, short, and a range inside it.
    await session.fetch(miss.blocks.slice(2));
    assert.deepEqual(reads, [{ path: 'a.bin', offset: 3 * PIECE_SIZE, length: 11 }]);
    assert.deepEqual(session.read('a.bin', 3 * PIECE_SIZE + 2, 100),
        bytes.subarray(3 * PIECE_SIZE + 2), 'clipped at the file\'s end');

    // Pieces of another file do not answer for this one's.
    await fetchedAgain(()=>session.read('b.bin', 0, 7), session);
    assert.deepEqual(session.read('b.bin', 0, 7), pattern(7, 8));

    // readInto hands each part where it lies in the range, from the pieces kept.
    await fetchedAgain(()=>session.read('a.bin', 0, 1), session);
    const into = new Uint8Array(PIECE_SIZE + 3);
    let count = 0;
    assert.equal(session.readInto('a.bin', PIECE_SIZE, 0, ()=>{}), 0,
        'an empty range hands nothing');
    await fetchedAgain(()=>session.read('a.bin', PIECE_SIZE, 1), session);
    const readsBefore = reads.length;
    assert.equal(session.readInto('a.bin', PIECE_SIZE - 4, into.length, (part, at)=>{
        count++;
        into.set(part, at);
    }), into.length);
    assert.equal(count, 2, 'a part a piece');
    assert.deepEqual(into, bytes.subarray(PIECE_SIZE - 4, PIECE_SIZE - 4 + into.length));
    assert.equal(reads.length, readsBefore, 'read from what was kept, nothing of the session');

    // Past the room it has, what was read least recently is let go of; read
    // again, it is fetched from the session again, the same bytes.
    for (const piece of [2, 3, 0, 1])
    {
        await fetchedAgain(()=>session.read('a.bin', piece * PIECE_SIZE, 1), session);
    }
    const readsNow = reads.length;
    const { result, misses } = await fetchedAgain(()=>session.read('a.bin', 2 * PIECE_SIZE, 4),
        session);
    assert.equal(misses, 1, 'the piece read longest ago was let go of');
    assert.deepEqual(result, bytes.subarray(2 * PIECE_SIZE, 2 * PIECE_SIZE + 4));
    assert.deepEqual(reads.slice(readsNow), [{ path: 'a.bin', offset: 2 * PIECE_SIZE,
        length: PIECE_SIZE }], 'read from the session again, that piece alone');
    assert.equal(session.reads().unkept, 0, 'every piece was kept by the keeper, none here');
    assert.deepEqual(session.held(), { sessionUnkept: 0 });
});

test('with nowhere to keep pieces, a fetch\'s pieces are held until the next fetch: a range'
    + ' is read after one fetch, and held bytes are said', async()=>{
    const bytes = pattern(3 * PIECE_SIZE, 9);
    const { files, reads } = lazySession({ 'a.bin': bytes });
    const session = createSessionSource(files);
    const { result, misses } = await fetchedAgain(()=>session.read('a.bin', 5, 2 * PIECE_SIZE),
        session);
    assert.equal(misses, 1);
    assert.deepEqual(result, bytes.subarray(5, 5 + 2 * PIECE_SIZE));
    assert.deepEqual(session.held(), { sessionUnkept: 3 * PIECE_SIZE });
    assert.deepEqual(session.reads(), { fetches: 1, pieces: 3, bytes: 3 * PIECE_SIZE, unkept: 3 });
    // The next fetch lets go of what the last one held.
    await fetchedAgain(()=>session.read('a.bin', 0, 1), session);
    assert.equal(reads.length, 3, 'the first piece was held, nothing fetched');
    await session.fetch([{ index: 2 }]);
    assert.deepEqual(session.held(), { sessionUnkept: PIECE_SIZE });
    assert.throws(()=>session.read('a.bin', 0, 1), (/** @type {any} */ e)=>e.code === 'BLOCK_MISS');
});

test('under a writable layer: a write copies the file up a piece at a time, a delete leaves'
    + ' a tombstone, and what was not touched is the session\'s own', async t=>{
    const big = pattern(5 * PIECE_SIZE + 7, 4);
    const { files } = lazySession({
        'Saves\\big.sav': big,
        'Saves\\small.sav': pattern(9, 5),
        'Saves\\gone.sav': pattern(9, 6),
        'config.ini': pattern(3, 7),
    });
    // Two pieces kept at once: a copy that began again at every miss would
    // never finish.
    const session = await sessionWithRoom(t, files, 2 * PIECE_SIZE);
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
