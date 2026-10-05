/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createRoot, nameKey, serializeCompoundFile } from '../ole32/cfb.js';
import { CompoundError, bytesSource, openCompound } from './compound.js';

/** @param {number} length @param {number} seed */
const pattern = (length, seed)=>Uint8Array.from({ length }, (_, at)=>(at * 31 + seed) & 0xff);

/**
 * A docfile with a stream in the mini stream, one past the cutoff, one of
 * many sectors and a storage with a stream of its own.
 */
const sample = ()=>{
    const root = createRoot();
    /** @param {Map<string, any>} into @param {string} name @param {Uint8Array} data */
    const stream = (into, name, data)=>{
        const entry = createEntry(name, 'stream');
        entry.data = data;
        into.set(nameKey(name), entry);
    };
    stream(root.children, 'small', pattern(100, 1));
    stream(root.children, 'edge', pattern(4096, 2));
    stream(root.children, 'large', pattern(300000, 3));
    stream(root.children, 'empty', new Uint8Array(0));
    const storage = createEntry('inner', 'storage');
    stream(storage.children, 'deep', pattern(777, 4));
    root.children.set(nameKey('inner'), storage);
    return serializeCompoundFile(root);
};

test('every stream reads back as it was written, in the mini stream and out of it', async()=>{
    const file = await openCompound(bytesSource(sample()));
    const names = [...file.root.children.values()].map(node=>node.name);
    assert.deepEqual(names, ['edge', 'empty', 'inner', 'large', 'small'],
        'shorter names first, as the directory orders them');
    for (const [name, length, seed] of /** @type {const} */ ([
        ['small', 100, 1], ['edge', 4096, 2], ['large', 300000, 3]]))
    {
        const node = /** @type {any} */ (file.root.children.get(nameKey(name)));
        assert.equal(node.size, length);
        assert.deepEqual(await file.readAll(node), pattern(length, seed), name);
    }
    const inner = /** @type {any} */ (file.root.children.get('INNER'));
    assert.equal(inner.kind, 'storage');
    assert.deepEqual(await file.readAll(inner.children.get('DEEP')), pattern(777, 4));
    assert.equal((await file.readAll(/** @type {any} */ (file.root.children.get('EMPTY'))))
        .length, 0);
});

test('a range is read from the sectors it spans, and cut short at the end', async()=>{
    const bytes = sample();
    /** @type {[number, number][]} */
    const reads = [];
    const file = await openCompound({ size: bytes.length, read: (offset, length)=>{
        reads.push([offset, length]);
        return bytes.subarray(offset, offset + length);
    } });
    const large = /** @type {any} */ (file.root.children.get('LARGE'));
    const whole = pattern(300000, 3);
    reads.length = 0;
    assert.deepEqual(await file.read(large, 1000, 5000), whole.subarray(1000, 6000));
    assert.ok(reads.reduce((sum, [, length])=>sum + length, 0) <= 5000 + 1024,
        'no more than the sectors the range touches');
    assert.deepEqual(await file.read(large, 299990, 100), whole.subarray(299990));
    assert.equal((await file.read(large, 400000, 10)).length, 0);
    const small = /** @type {any} */ (file.root.children.get('SMALL'));
    assert.deepEqual(await file.read(small, 60, 10), pattern(100, 1).subarray(60, 70),
        'across two mini sectors');
});

test('bytes that are not a compound file, or a damaged one, are refused', async()=>{
    await assert.rejects(openCompound(bytesSource(new Uint8Array(1024))), CompoundError);
    const bytes = sample();
    // The directory's first sector pointed past the end of the file.
    bytes.set([0xff, 0xff, 0xff, 0x0f], 0x30);
    await assert.rejects(openCompound(bytesSource(bytes)), CompoundError);
});
