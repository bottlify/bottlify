/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesPerCall } from '../../../../../tools/fixtures/allocation.mjs';

import { cacheSpace, createCacheModule } from './module.js';
import { grainsOf } from '@bottlify/cellar';

import { NoRoom, createScratches } from './scratch.js';
import { testCache } from './testing.fixture.js';

const MIB = 1 << 20;
/** A DirectDraw program's screen, 1024 by 768 at four bytes: what it blits every frame. */
const SCREEN = 1024 * 768 * 4;

test('a room is all the cache places for its length, and a hold of nothing is a room too',
    async()=>{
        const cache = await testCache();
        const scratches = createScratches(cache.space('scratch').hold);
        scratches.scratch('odd').bytes(4097);
        assert.equal(scratches.figures().heldBytes, grainsOf(4097));
        scratches.hold('none', 0);
        assert.equal(scratches.figures().heldBytes, grainsOf(4097) + grainsOf(1));
        cache.idle(1);
        assert.equal(cache.keeper.under('scratch/').placedBytes, scratches.figures().heldBytes,
            'what the scratches count is what the cache placed');
    });

test('a scratch reused call after call is held once in the run\'s cache, counted there', async()=>{
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    const blit = scratches.scratch('blit');
    const first = blit.bytes(SCREEN);
    assert.equal(first.length, SCREEN);
    assert.equal(first.byteOffset % grainsOf(1), 0, 'a room of the cache, at a grain of it');
    assert.ok(first.buffer instanceof SharedArrayBuffer, 'the cache\'s own memory');
    first.fill(0x5a);
    for (let frame = 0; frame < 100; frame++)
    {
        assert.equal(blit.bytes(SCREEN), first, 'the same view, nothing made');
    }
    // The keeper's sweep never takes a held room back, however long it waits.
    cache.idle(10 * 60_000);
    assert.equal(blit.bytes(SCREEN)[SCREEN - 1], 0x5a,
        'what was written stays while it did not grow');
    assert.deepEqual(scratches.figures(), { scratches: 1, holds: 0, held: 1,
        heldBytes: grainsOf(SCREEN), grows: 1, refused: 0 });
    const under = cache.keeper.under('scratch/');
    assert.equal(under.bodies, 1);
    assert.equal(under.hotBytes, grainsOf(SCREEN), 'in the run\'s budget');
    // A shorter call is a view of the same room.
    const row = blit.bytes(640);
    assert.equal(row.buffer, first.buffer);
    assert.equal(row.byteOffset, first.byteOffset);
    assert.equal(row.length, 640);
    assert.equal(scratches.figures().grows, 1);
});

test('a scratch that grows holds the larger room and lets the smaller go', async()=>{
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    const scratch = scratches.scratch('room');
    scratch.bytes(1000);
    scratch.bytes(70_000);
    assert.equal(scratches.figures().grows, 2);
    assert.equal(scratches.figures().heldBytes, grainsOf(70_000));
    cache.idle(1);
    assert.deepEqual(cache.keeper.under('scratch/'), { bodies: 1, bytes: grainsOf(70_000),
        hotBytes: grainsOf(70_000), placedBytes: grainsOf(70_000) });
    scratch.release();
    cache.idle(1);
    assert.equal(cache.keeper.under('scratch/').bodies, 0, 'released: the cache\'s again');
    assert.equal(scratches.figures().held, 0);
    assert.equal(scratches.figures().heldBytes, 0);
});

test('a room the cache has none for is refused, counted: no memory stands in for it', async()=>{
    // One segment of 1 MiB: a room larger than a segment has no block to take.
    const cache = await testCache({ budget: MIB, segmentBytes: MIB });
    const scratches = createScratches(cache.space('scratch').hold);
    const scratch = scratches.scratch('large');
    assert.throws(()=>scratch.bytes(2 * MIB), NoRoom);
    assert.deepEqual(scratches.figures(), { scratches: 1, holds: 0, held: 0, heldBytes: 0,
        grows: 1, refused: 1 });
    // A room that fits is held once asked for.
    assert.equal(scratch.bytes(4096).buffer instanceof SharedArrayBuffer, true);
    assert.equal(scratches.figures().held, 1);
});

test('a scratch reused across calls makes nothing a call', async()=>{
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    const scratch = scratches.scratch('loop');
    scratch.bytes(SCREEN);
    /** @type {Uint8Array} */
    let view = new Uint8Array(0);
    assert.ok(await bytesPerCall(()=>{
        view = scratch.bytes(SCREEN);
    }) < 4);
    assert.equal(view.length, SCREEN);
    assert.equal(scratches.figures().grows, 1, 'the counter of grows stays put');
});

test('the cache layer hands out scratches and reports them; without a reader it is not built',
    async()=>{
        const cache = await testCache();
        const module = createCacheModule();
        const api = await module.create({ reader: cache.reader });
        const scratch = api.scratch('blit');
        scratch.bytes(SCREEN);
        const figures = /** @type {any} */ (module.diagnostics().metrics.scratch);
        assert.equal(figures.held, 1);
        assert.equal(figures.heldBytes, grainsOf(SCREEN));
        assert.equal(cache.keeper.under('scratch/').hotBytes, grainsOf(SCREEN));
        // A process that goes lets go of what its layers still held.
        await module.dispose();
        cache.idle(1);
        assert.equal(cache.keeper.under('scratch/').bodies, 0);

        // A process always has a cache: nothing stands in for a missing one.
        const alone = createCacheModule();
        await assert.rejects(alone.create(null), /built without a reader/);
        await assert.rejects(alone.create({}), /built without a reader/);
        assert.equal(alone.diagnostics().status, 'created');
        assert.throws(()=>cacheSpace(/** @type {any} */ (null), 'tool'), /has no reader/);
    });

test('a hold is memory of its own length for an object\'s life: held in a block of the cache, '
    + 'zero though the block was used before, let go of once', async()=>{
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    // A block used and let go: the next holder of it finds what was left.
    const before = scratches.hold('resource', 70_000);
    before.bytes.fill(0xee);
    before.release();
    cache.idle(1);
    const held = scratches.hold('resource', 70_000);
    assert.equal(held.bytes.length, 70_000);
    assert.ok(held.bytes.buffer instanceof SharedArrayBuffer);
    assert.equal(held.bytes.byteOffset, before.bytes.byteOffset, 'the same block again');
    assert.ok(held.bytes.every(byte=>byte === 0), 'zero, as new memory is');
    const other = scratches.hold('resource', 70_000);
    assert.notEqual(other.bytes.byteOffset, held.bytes.byteOffset, 'two of one name, two holds');
    // The keeper's sweep never takes it, however long it waits.
    held.bytes.fill(5);
    cache.idle(10 * 60_000);
    assert.equal(held.bytes[69_999], 5);
    assert.deepEqual(scratches.figures(), { scratches: 0, holds: 3, held: 2,
        heldBytes: 2 * grainsOf(70_000), grows: 0, refused: 0 });
    assert.equal(cache.keeper.under('scratch/').bodies, 2);
    held.release();
    held.release();
    assert.equal(scratches.figures().held, 1, 'let go of once');
    scratches.releaseAll();
    cache.idle(1);
    assert.equal(cache.keeper.under('scratch/').bodies, 0, 'the holder gone, nothing left');
    other.release();
    assert.equal(scratches.figures().held, 0);
});

test('a hold with no room in the cache is refused, counted', async()=>{
    const cache = await testCache({ budget: MIB, segmentBytes: MIB });
    const scratches = createScratches(cache.space('scratch').hold);
    assert.throws(()=>scratches.hold('resource', 3 * MIB + 5), NoRoom);
    assert.deepEqual(scratches.figures(), { scratches: 0, holds: 1, held: 0, heldBytes: 0,
        grows: 0, refused: 1 });
});
