/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    bottleStorage, clearBottleStorage, keepStorageWithin, STORAGE_SHARE,
} from './storage-budget.js';

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
    root.file('old-aaaa.present', 1, 1);
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
    assert.ok(!root.children.has('old-aaaa.blocks') && !root.children.has('old-aaaa.order'));
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

/**
 * A browser over a fake origin: its storage, and locks of which `held` are
 * taken by runs.
 *
 * @param {any} root @param {string[]} [held]
 */
function browser(root, held = []){
    return {
        storage: {
            getDirectory: async()=>root,
            estimate: async()=>({ usage: 5000, quota: 100000 }),
            persisted: async()=>true,
        },
        locks: {
            query: async()=>({ held: held.map(name=>({ name })) }),
            /** @param {string} name @param {any} options @param {Function} work */
            request: async(name, options, work)=>work(held.includes(name) ? null : { name }),
        },
    };
}

/**
 * Two packings of one bottle's blocks, its translations and saves; an orphan's
 * cache with the appended layout's table left beside it; a session alone.
 */
function bottles(){
    const root = fakeDirectory();
    root.file('game-0a1b2c3d.blocks', 500, 9);
    root.file('game-0a1b2c3d.present', 2, 9);
    root.file('game-0a1b2c3d.order', 8, 9);
    root.file('game-ffffffff.blocks', 300, 1);
    root.file('gone-12345678.blocks', 700, 3);
    root.file('gone-12345678.present', 1, 3);
    root.file('gone-12345678.slots', 40, 3);
    // A cache whose data is cut into segments rather than one file.
    root.file('split-abcdef01.blocks.0', 60, 7);
    root.file('split-abcdef01.blocks.1', 40, 7);
    root.file('split-abcdef01.present', 1, 7);
    root.file('solo.session', 60, 4);
    const saves = root.directory('game.files');
    saves.file('a', 30, 5);
    saves.file('b', 20, 6);
    root.directory('bottles').directory('game').file('bundle.btl', 9999, 1);
    const cork = root.directory('cork');
    cork.directory('game.v9').file('records', 100, 9);
    cork.directory('gone.v8').file('records', 70, 2);
    return root;
}

test('every bottle\'s storage is listed by kind, an orphan\'s and a leftover table too', async()=>{
    const listed = await bottleStorage(browser(bottles(), ['bottlify-cork:game']));
    assert.equal(listed.usage, 5000);
    assert.equal(listed.quota, 100000);
    assert.equal(listed.persisted, true);
    const by = Object.fromEntries(listed.bottles.map(one=>[one.bottle, one]));
    assert.deepEqual(Object.keys(by).sort(), ['game', 'gone', 'solo', 'split'],
        'a launcher\'s own folders are not the engine\'s to list');
    assert.equal(by.split.blocks, 101, 'a segmented cache counts every segment');
    assert.deepEqual(by.game, { bottle: 'game', busy: true, blocks: 810, translations: 100,
        saves: 50 }, 'both packings\' blocks, the session\'s folder added up');
    assert.deepEqual(by.gone, { bottle: 'gone', busy: false, blocks: 741, translations: 70,
        saves: 0 });
    assert.deepEqual(by.solo, { bottle: 'solo', busy: false, blocks: 0, translations: 0,
        saves: 60 }, 'a session in its one-file form');
});

test('clearing a bottle\'s cache takes its blocks and translations and never its saves', async()=>{
    const root = bottles();
    const removed = await clearBottleStorage('gone', ['blocks', 'translations'], browser(root));
    assert.deepEqual(removed.map(one=>`${one.kind}:${one.name}:${one.bytes}`).sort(),
        ['blocks:gone-12345678:741', 'translations:gone.v8:70']);
    assert.ok(!root.children.has('gone-12345678.slots'), 'the leftover table goes with its cache');
    assert.ok(!root.children.get('cork').children.has('gone.v8'));

    await clearBottleStorage('game', ['blocks', 'translations'], browser(root));
    assert.ok(root.children.has('game.files'), 'saves are not a cache');
    assert.ok(![...root.children.keys()].some(name=>name.startsWith('game-')));
    assert.ok(root.children.has('bottles') && root.children.has('solo.session'));

    await clearBottleStorage('split', ['blocks'], browser(root));
    assert.ok(![...root.children.keys()].some(name=>name.startsWith('split-')),
        'every segment goes with its cache');
});

test('saves go only when asked for, in either form', async()=>{
    const root = bottles();
    await clearBottleStorage('solo', ['saves'], browser(root));
    assert.ok(!root.children.has('solo.session'));
    await clearBottleStorage('game', ['saves'], browser(root));
    assert.ok(!root.children.has('game.files'));
    assert.ok(root.children.has('game-0a1b2c3d.blocks'), 'the cache stays');
});

test('a running bottle is refused and keeps everything', async()=>{
    const root = bottles();
    await assert.rejects(clearBottleStorage('game', ['blocks', 'translations', 'saves'],
        browser(root, ['bottlify-cork:game'])), /in use by a running title/);
    assert.ok(root.children.has('game-0a1b2c3d.blocks') && root.children.has('game.files'));
});

test('a browser that says nothing of its usage is not measured', async()=>{
    const root = bottles();
    const listed = await bottleStorage({ storage: { getDirectory: async()=>root }, locks: {} });
    assert.equal(listed.usage, null);
    assert.equal(listed.quota, null);
    assert.equal(listed.persisted, null);
    assert.equal(listed.bottles.length, 4);
});
