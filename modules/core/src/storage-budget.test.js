/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepStorageWithin, STORAGE_SHARE } from './storage-budget.js';

/**
 * The origin's file system as the budget reads it: directories of files that
 * say their size and when they were last written, and a removal a test can
 * refuse, as a file another tab holds open is refused.
 *
 * @param {Set<string>} [refused]  names whose removal fails
 */
function fakeDirectory(refused = new Set()){
    /** @type {Map<string, any>} */
    const children = new Map();
    return {
        children,
        /** @param {string} name @param {number} size @param {number} modified */
        file(name, size, modified){
            children.set(name, { getFile: async()=>({ size, lastModified: modified }) });
        },
        /** @param {string} name */
        directory(name){
            const child = fakeDirectory(refused);
            children.set(name, child);
            return child;
        },
        async* entries(){
            yield* [...children];
        },
        /** @param {string} name */
        async removeEntry(name){
            if (refused.has(name))
            {
                throw new Error('NoModificationAllowedError');
            }
            children.delete(name);
        },
    };
}

/**
 * Three bundles' block caches and translations, the oldest written first, and
 * a saved session the budget must never touch.
 *
 * @param {Set<string>} [refused]
 */
function origin(refused){
    const root = fakeDirectory(refused);
    root.file('old-aaaa.blocks', 300, 1);
    root.file('old-aaaa.slots', 1, 1);
    root.file('old-aaaa.order', 1, 1);
    root.file('mid-bbbb.blocks', 200, 5);
    root.file('mid-bbbb.present', 1, 5);
    root.file('game-cccc.blocks', 500, 9);
    root.file('game-cccc.present', 1, 9);
    root.file('game-0000.blocks', 400, 2);
    root.file('game.files', 1000, 0);
    root.file('game.session', 50, 0);
    const cork = root.directory('cork');
    const old = cork.directory('old.v9');
    old.file('records', 100, 3);
    old.file('index', 10, 3);
    const mid = cork.directory('mid.v9');
    mid.file('records', 80, 6);
    const game = cork.directory('game.v9');
    game.file('records', 700, 9);
    return root;
}

test('under its budget the origin keeps every cache', async()=>{
    const root = origin();
    const result = await keepStorageWithin({ root,
        estimate: { usage: 3000, quota: 10000 }, keep: {} });
    assert.equal(result.measured, true);
    assert.deepEqual(result.measured && result.evicted, []);
    assert.equal(root.children.size, 11);
});

test('past its budget the oldest caches go first, never the run\'s own or a session', async()=>{
    const root = origin();
    // Budget 0.8 * 4000 = 3200; usage 3600 asks for 400 bytes and more.
    const result = await keepStorageWithin({ root, estimate: { usage: 3600, quota: 4000 },
        keep: { blocks: 'game-cccc', translations: 'game' } });
    assert.ok(result.measured);
    assert.equal(result.budget, Math.floor(4000 * STORAGE_SHARE));
    assert.deepEqual(result.evicted.map(one=>`${one.kind}:${one.name}:${one.bytes}`),
        ['blocks:old-aaaa:302', 'blocks:game-0000:400'],
        'the oldest first, the run\'s own bundle\'s earlier packing among them');
    assert.equal(result.freed, 702);
    assert.equal(result.over, false);
    assert.ok(!root.children.has('old-aaaa.blocks') && !root.children.has('old-aaaa.slots')
        && !root.children.has('old-aaaa.order'));
    assert.ok(root.children.has('game-cccc.blocks'), 'the run\'s own blocks stay');
    assert.ok(root.children.has('game.files') && root.children.has('game.session'),
        'a session is never a cache');
});

test('a translations\' directory goes whole, by its newest file\'s age', async()=>{
    const root = origin();
    const result = await keepStorageWithin({ root, estimate: { usage: 4000, quota: 4000 },
        keep: { blocks: 'game-cccc', translations: 'game' } });
    assert.ok(result.measured);
    assert.deepEqual(result.evicted.map(one=>one.name), ['old-aaaa', 'game-0000', 'old.v9'],
        'by age: blocks 1, blocks 2, translations 3; blocks 5 not needed');
    assert.equal(result.freed, 812);
    const cork = root.children.get('cork');
    assert.ok(!cork.children.has('old.v9'));
    assert.ok(cork.children.has('mid.v9') && cork.children.has('game.v9'));
    assert.ok(root.children.has('mid-bbbb.blocks'));
    assert.equal(result.over, false);
});

test('a bundle a run in another tab holds keeps its caches, and a refused file stays', async()=>{
    const root = origin(new Set(['mid-bbbb.blocks']));
    const result = await keepStorageWithin({ root, estimate: { usage: 9000, quota: 4000 },
        keep: { blocks: 'game-cccc', translations: 'game' },
        busy: ['bottlify-cork:old', 'something-else'] });
    assert.ok(result.measured);
    assert.deepEqual(result.evicted.map(one=>one.name), ['game-0000', 'mid.v9'],
        'old\'s blocks and translations are another run\'s; mid\'s file is held open');
    assert.ok(root.children.has('old-aaaa.blocks'));
    assert.ok(root.children.has('mid-bbbb.blocks'));
    assert.equal(result.over, true, 'nothing else could go');
});

test('a browser that gives no estimate is not measured, and nothing goes', async()=>{
    const root = origin();
    const result = await keepStorageWithin({ root, estimate: {}, keep: {} });
    assert.equal(result.measured, false);
    assert.equal(root.children.size, 11);
});
