/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './memory-store.js';

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
