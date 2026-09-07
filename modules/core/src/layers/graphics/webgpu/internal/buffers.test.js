/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockFlags, alignOutward, createDynamicBuffer } from './buffers.js';
import { createFakeDevice } from './fake-device.js';

/** @param {number} size @param {number} [alignment] */
function buffer(size, alignment = 4){
    const gpu = createFakeDevice();
    const dynamic = createDynamicBuffer({
        device: gpu.device,
        queue: gpu.queue,
        size,
        usage: 0,
        label: 'vertices',
        alignment,
    });
    return { gpu, dynamic };
}

/**
 * Writes a recognisable pattern through a lease and closes it.
 *
 * @param {any} dynamic @param {number} offset @param {number} length
 * @param {number} flags @param {number} [seed]
 */
function fill(dynamic, offset, length, flags, seed = 0x11){
    const lock = dynamic.lock(offset, length, flags);
    lock.data.fill(seed);
    dynamic.unlock(lock);
}

test('an outward alignment never trims the written bytes off either end', ()=>{
    assert.deepEqual(alignOutward(5, 8, 4), { start: 4, end: 8 });
    assert.deepEqual(alignOutward(5, 9, 4), { start: 4, end: 12 });
    assert.deepEqual(alignOutward(0, 1, 256), { start: 0, end: 256 });
    assert.deepEqual(alignOutward(8, 16, 4), { start: 8, end: 16 },
        'an already-aligned range is left alone');
});

test('DISCARD sends only the dirty range, from that range own offset', ()=>{
    const { gpu, dynamic } = buffer(4096);

    fill(dynamic, 260, 40, LockFlags.DISCARD);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].bufferOffset, 260, 'the upload starts where the guest wrote');
    assert.equal(writes[0].dataOffset, 260, 'and reads the shadow copy from the same offset');
    assert.equal(writes[0].size, 40);
});

test('a lock with neither flag renames, and a rename resends the whole buffer', ()=>{
    const { gpu, dynamic } = buffer(4096);

    fill(dynamic, 64, 16, LockFlags.NONE);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].bufferOffset, 0,
        'the old contents stayed observable, so all of it travels');
    assert.equal(writes[0].size, 4096);
    assert.equal(dynamic.renames, 1);
});

test('NOOVERWRITE writes into the live buffer and uploads only what was locked', ()=>{
    const { gpu, dynamic } = buffer(4096);
    const first = dynamic.gpu;

    fill(dynamic, 128, 32, LockFlags.NOOVERWRITE);
    dynamic.flush();

    assert.equal(dynamic.gpu, first, 'NOOVERWRITE must not rename');
    assert.equal(dynamic.renames, 0);
    const writes = gpu.of('writeBuffer');
    assert.equal(writes[0].bufferOffset, 128);
    assert.equal(writes[0].size, 32);
});

test('several locks since the last upload merge into one range', ()=>{
    const { gpu, dynamic } = buffer(4096);

    fill(dynamic, 260, 8, LockFlags.DISCARD);
    fill(dynamic, 300, 8, LockFlags.NOOVERWRITE);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1, 'one upload, not one per lock');
    assert.equal(writes[0].bufferOffset, 260);
    assert.equal(writes[0].size, 48, 'the union of both ranges, aligned outward');
});

test('a rename flushes the outgoing buffer before handing out the new one', ()=>{
    const { gpu, dynamic } = buffer(4096);

    fill(dynamic, 0, 16, LockFlags.DISCARD, 0xaa);
    const outgoing = dynamic.gpu;
    fill(dynamic, 0, 16, LockFlags.DISCARD, 0xbb);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 2, 'each generation carries its own bytes');
    assert.equal(writes[0].buffer, outgoing,
        'the outgoing generation was uploaded before it was retired');
    assert.equal(writes[0].bytes[0], 0xaa, 'and with the bytes it had at the time');
    assert.notEqual(writes[1].buffer, outgoing);
    assert.equal(writes[1].bytes[0], 0xbb);
});

test('an unlocked range that was never written still travels, an empty one does not', ()=>{
    const { gpu, dynamic } = buffer(4096);

    dynamic.flush();
    assert.equal(gpu.count('writeBuffer'), 0, 'nothing dirty, nothing sent');

    const lock = dynamic.lock(0, 8, LockFlags.NOOVERWRITE);
    dynamic.unlock(lock);
    assert.equal(dynamic.flush(), 8, 'a closed lock is dirty whether or not it was written');
});

test('retired buffers come back after a frame boundary instead of allocating forever', ()=>{
    const { gpu, dynamic } = buffer(4096);
    const first = dynamic.gpu;

    fill(dynamic, 0, 16, LockFlags.DISCARD);
    const second = dynamic.gpu;
    assert.notEqual(second, first);
    assert.equal(gpu.count('createBuffer'), 2);

    dynamic.endFrame();
    fill(dynamic, 0, 16, LockFlags.DISCARD);
    assert.equal(gpu.count('createBuffer'), 2, 'the retired buffer was reused');
    assert.equal(dynamic.gpu, first);
});

test('a buffer in flight this frame is not recycled into itself', ()=>{
    const { dynamic } = buffer(4096);

    fill(dynamic, 0, 16, LockFlags.DISCARD);
    const second = dynamic.gpu;
    fill(dynamic, 0, 16, LockFlags.DISCARD);
    assert.notEqual(dynamic.gpu, second,
        'a buffer retired in this frame may still be read by draws already recorded');
});

test('a second outstanding lock and an out-of-range lock are both refused', ()=>{
    const { dynamic } = buffer(4096);

    const lock = dynamic.lock(0, 16, LockFlags.DISCARD);
    assert.throws(()=>dynamic.lock(32, 16, LockFlags.NOOVERWRITE), /already locked/);
    dynamic.unlock(lock);

    assert.throws(()=>dynamic.lock(4090, 16, LockFlags.DISCARD), /out of range/);
    assert.throws(()=>dynamic.lock(0, 0, LockFlags.DISCARD), /out of range/);
});

test('the upload cost is reported per buffer, not just in total', ()=>{
    /** @type {[string, number][]} */
    const uploads = [];
    const gpu = createFakeDevice();
    const dynamic = createDynamicBuffer({
        device: gpu.device,
        queue: gpu.queue,
        size: 1024,
        usage: 0,
        label: 'indices',
        onUpload: (label, bytes)=>uploads.push([label, bytes]),
    });

    fill(dynamic, 17, 20, LockFlags.DISCARD);
    dynamic.flush();

    assert.deepEqual(uploads, [['indices', 24]], 'aligned outward from 17..37 to 16..40');
});
