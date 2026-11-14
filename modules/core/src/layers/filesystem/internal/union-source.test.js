/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './memory-store.js';
import { createOverlay } from './tree.js';
import { createUnionSource } from './union-source.js';

/** @param {Uint8Array} data */
const text = data=>[...data].map(byte=>String.fromCharCode(byte)).join('');

/** A bottle over a layer, each with a file of its own, one they share, and a folder in common. */
function bottleOverLayer(){
    const bottle = createMemoryStore({
        'Windows\\Microsoft.NET\\Framework\\machine.config': 'bottle',
        'Windows\\Microsoft.NET\\Framework\\app.config': 'own',
    });
    const layer = createMemoryStore({
        'WINDOWS\\Microsoft.NET\\Framework\\machine.config': 'layer!',
        'WINDOWS\\Microsoft.NET\\Framework\\clr.dll': 'runtime',
        'WINDOWS\\system32\\mscoree.dll': 'shim',
    });
    return { bottle, layer, union: createUnionSource([bottle, layer]) };
}

test('the first source that has a file answers for it, in either one\'s spelling', ()=>{
    const { union } = bottleOverLayer();

    assert.equal(text(union.read('Windows\\Microsoft.NET\\Framework\\machine.config', 0, 16)),
        'bottle');
    assert.equal(text(union.read('WINDOWS\\MICROSOFT.NET\\Framework\\machine.config', 0, 16)),
        'bottle', 'the lower source\'s spelling reaches the upper source\'s file');
    assert.deepEqual(union.stat('windows\\microsoft.net\\framework\\machine.config'),
        { directory: false, size: 6 });
});

test('a file only the lower source has is read from it', ()=>{
    const { union } = bottleOverLayer();

    assert.equal(text(union.read('Windows\\Microsoft.NET\\Framework\\clr.dll', 0, 16)), 'runtime');
    assert.equal(text(union.read('windows\\system32\\mscoree.dll', 1, 2)), 'hi');
    assert.equal(union.stat('Windows\\Missing.dll'), null);
    assert.throws(()=>union.read('Windows\\Missing.dll', 0, 1), { code: 'NOT_FOUND' });
    assert.throws(()=>union.read('Windows\\Microsoft.NET', 0, 1), { code: 'NOT_FOUND' },
        'a directory has no bytes');
});

test('directories merge: one entry a path, the upper source\'s', ()=>{
    const { union } = bottleOverLayer();

    const listed = union.list().map(entry=>`${entry.path}${entry.directory ? '\\' : ''}`).sort();
    assert.deepEqual(listed, [
        'WINDOWS\\Microsoft.NET\\Framework\\clr.dll',
        'WINDOWS\\system32\\',
        'WINDOWS\\system32\\mscoree.dll',
        'Windows\\',
        'Windows\\Microsoft.NET\\',
        'Windows\\Microsoft.NET\\Framework\\',
        'Windows\\Microsoft.NET\\Framework\\app.config',
        'Windows\\Microsoft.NET\\Framework\\machine.config',
    ]);
    assert.deepEqual(union.stat('WINDOWS\\Microsoft.NET'), { directory: true, size: 0 });
    const implied = createUnionSource([createMemoryStore(),
        { list: ()=>[{ path: 'Deep\\file.txt', directory: false, size: 1 }],
            stat: ()=>null, read: ()=>new Uint8Array(0) }]);
    assert.deepEqual(implied.stat('deep'), { directory: true, size: 0 },
        'a directory only implied by what is under it is one');

    // What a program sees through the overlay: one folder, every file of both.
    const tree = createOverlay({ source: union, writable: createMemoryStore() });
    assert.deepEqual(tree.list(['windows', 'microsoft.net', 'framework'])
        .map(entry=>entry.name).sort(), ['app.config', 'clr.dll', 'machine.config']);
    assert.equal(text(tree.read(['WINDOWS', 'MICROSOFT.NET', 'FRAMEWORK', 'MACHINE.CONFIG'],
        0, 16)), 'bottle');
    assert.equal(tree.size(['windows', 'microsoft.net', 'framework', 'machine.config']), 6);
});

test('a file shadows whatever a lower source holds at its path or under it', ()=>{
    const upper = createMemoryStore({ 'Data': 'a file', 'Logs\\today.txt': 'log' });
    const lower = createMemoryStore({ 'data\\inner.bin': 'hidden', 'LOGS': 'not a dir' });
    const union = createUnionSource([upper, lower]);

    assert.deepEqual(union.list().map(entry=>entry.path).sort(),
        ['Data', 'Logs', 'Logs\\today.txt']);
    assert.equal(union.stat('Data\\inner.bin'), null);
    assert.deepEqual(union.stat('logs'), { directory: true, size: 0 });
});

test('a read the source cannot answer yet is passed through as it is: a miss, or a promise', ()=>{
    const miss = Object.assign(new Error('not resident'), { code: 'BLOCK_MISS',
        blocks: [{ index: 3, offset: 0, packed: 16 }] });
    const pending = Promise.resolve(new Uint8Array(4));
    const layer = { ...createMemoryStore({ 'far.bin': 'xxxx', 'later.bin': 'yyyy' }),
        /** @param {string} path @returns {any} */
        read(path){
            if (path === 'later.bin')
            {
                return pending;
            }
            throw miss;
        } };
    const union = createUnionSource([createMemoryStore({ 'near.bin': 'z' }), layer]);

    assert.throws(()=>union.read('FAR.BIN', 0, 4), error=>error === miss);
    assert.equal(union.read('later.bin', 0, 4), pending);
});

test('each source is listed once, however many times the union is', ()=>{
    /** @param {Record<string, string>} seed */
    const counted = seed=>{
        const store = createMemoryStore(seed);
        const counter = { lists: 0, store: { ...store, list: ()=>{
            counter.lists++;
            return store.list();
        } } };
        return counter;
    };
    const upper = counted({ 'a.txt': 'a' });
    const lower = counted({ 'b.txt': 'b' });
    const union = createUnionSource([upper.store, lower.store]);
    union.list();
    union.list();
    createOverlay({ source: union, writable: createMemoryStore() });

    assert.deepEqual([upper.lists, lower.lists], [1, 1]);
});
