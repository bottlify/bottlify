/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockFlags, alignOutward, carriedRanges, createDynamicBuffer } from './buffers.js';
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
    // The rest of the contents is carried on the GPU, not sent.
    const { gpu, dynamic } = carrying(4096);

    fill(dynamic, 260, 40, LockFlags.DISCARD);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].bufferOffset, 260, 'the upload starts where the guest wrote');
    assert.equal(writes[0].dataOffset, 260, 'and reads the shadow copy from the same offset');
    assert.equal(writes[0].size, 40);
});

test('a lock with neither flag sends only the locked range when no draw has read it', ()=>{
    // The ordinary case: a program fills a range and then draws from it. The
    // bytes that were not locked are already in the live backing, so resending
    // the whole buffer is traffic the guest never asked for.
    const { gpu, dynamic } = buffer(1 << 20);

    fill(dynamic, 4096, 4096, LockFlags.NONE);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].bufferOffset, 4096, 'the upload starts where the guest wrote');
    assert.equal(writes[0].size, 4096);
    assert.equal(dynamic.renames, 0, 'nothing had read it, so nothing had to be renamed');
});

test('a lock with neither flag after a read renames and resends the whole buffer', ()=>{
    // A draw already recorded this frame reads the bytes the lock would write
    // over, so the backing has to be renamed and the old contents carried into
    // the new one, which means all of it travels.
    const { gpu, dynamic } = buffer(4096);

    dynamic.markRead();
    fill(dynamic, 64, 16, LockFlags.NONE);
    dynamic.flush();

    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].bufferOffset, 0,
        'the old contents stayed observable, so all of it travels');
    assert.equal(writes[0].size, 4096);
    assert.equal(dynamic.renames, 1);
});

test('a submitted frame forgets its reads, so the next lock writes in place again', ()=>{
    const { gpu, dynamic } = buffer(1 << 20);

    dynamic.markRead();
    fill(dynamic, 0, 16, LockFlags.NONE);
    dynamic.flush();
    assert.equal(dynamic.renames, 1);
    assert.equal(gpu.of('writeBuffer').at(-1).size, 1 << 20);

    dynamic.endFrame();
    fill(dynamic, 32, 16, LockFlags.NONE);
    dynamic.flush();
    assert.equal(dynamic.renames, 1, 'no second rename once the read had been submitted');
    assert.equal(gpu.of('writeBuffer').at(-1).size, 16);
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
    const { gpu, dynamic } = carrying(4096);

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
        carry: ()=>{},
    });

    fill(dynamic, 17, 20, LockFlags.DISCARD);
    dynamic.flush();

    assert.deepEqual(uploads, [['indices', 24]], 'aligned outward from 17..37 to 16..40');
});

test('a backing is not reused until the frame that read it has been submitted', ()=>{
    const { gpu, dynamic } = buffer(4096);
    const first = dynamic.gpu;

    // Frame one is recorded and presented; its draws read `first`.
    fill(dynamic, 0, 16, LockFlags.DISCARD);
    const second = dynamic.gpu;
    dynamic.markPresent();

    // Frame two is recorded before either has been submitted -- the guest runs
    // ahead of the replay chain. Its rename retires `second`, which frame two's
    // own draws read.
    fill(dynamic, 0, 16, LockFlags.DISCARD);
    dynamic.markPresent();
    assert.equal(gpu.count('createBuffer'), 3, 'three backings, none reused yet');

    // Frame one submits. Only `first` is free; `second` is still read by frame
    // two, which has not been drawn.
    dynamic.endFrame();
    fill(dynamic, 0, 16, LockFlags.DISCARD);
    assert.equal(dynamic.gpu, first, 'the first frame\'s backing came back');
    assert.notEqual(dynamic.gpu, second, 'the second frame\'s is still in flight');
    assert.equal(gpu.count('createBuffer'), 3, 'and no fourth had to be made');

    // Frame two submits. Now `second` is free.
    dynamic.endFrame();
    fill(dynamic, 0, 16, LockFlags.DISCARD);
    assert.equal(dynamic.gpu, second, 'released once its frame was submitted');
});

/**
 * A buffer whose renames carry the old contents on the GPU, and the frame's
 * end as the backend runs it: uploads flushed, the carries copied in a command
 * buffer submitted ahead of the frame's, then the frame ended.
 *
 * @param {number} size
 */
function carrying(size){
    const gpu = createFakeDevice();
    /** @type {import('./buffers.js').Carry[]} */
    const carries = [];
    const dynamic = createDynamicBuffer({
        device: gpu.device, queue: gpu.queue, size, usage: 0, label: 'vertices',
        carry: carry=>carries.push(carry),
    });
    const endFrame = ()=>{
        dynamic.flush();
        const encoder = gpu.device.createCommandEncoder();
        for (const carry of carries.splice(0))
        {
            for (const range of carriedRanges(carry))
            {
                encoder.copyBufferToBuffer(carry.from, range.start, carry.to, range.start,
                    range.end - range.start);
            }
        }
        gpu.queue.submit([encoder.finish()]);

        dynamic.endFrame();
    };
    return { gpu, dynamic, endFrame };
}

test('a lock with neither flag after a read carries the rest on the GPU and sends the range', ()=>{
    // World of Warcraft locks part of a large buffer a draw of the frame has
    // read: resending all of it was most of a frame's uploads.
    const { gpu, dynamic, endFrame } = carrying(1 << 20);
    fill(dynamic, 0, 1 << 20, LockFlags.NONE, 0x22);
    endFrame();
    const first = dynamic.gpu;

    dynamic.markRead();
    fill(dynamic, 4096, 64, LockFlags.NONE, 0x33);
    fill(dynamic, 8192, 64, LockFlags.NOOVERWRITE, 0x44);
    const before = gpu.of('writeBuffer').length;
    endFrame();

    assert.notEqual(dynamic.gpu, first, 'renamed: the draw that read it keeps its bytes');
    const uploads = gpu.of('writeBuffer').slice(before);
    assert.equal(uploads.reduce((sum, one)=>sum + one.size, 0), 4096 + 64,
        'only the span the two locks wrote travels');
    const expected = new Uint8Array(1 << 20).fill(0x22);
    expected.fill(0x33, 4096, 4160);
    expected.fill(0x44, 8192, 8256);
    assert.deepEqual(dynamic.gpu.bytes, expected, 'the new backing holds everything');
    assert.ok(first.bytes.subarray(4096, 4160).every((/** @type {number} */ byte)=>byte === 0x22),
        'and the old one what the draw read');
});

test('carried ranges are the complement of what was written, in order', ()=>{
    assert.deepEqual(carriedRanges({ from: null, to: null, size: 100,
        written: [{ start: 40, end: 60 }, { start: 0, end: 8 }, { start: 50, end: 70 }] }),
    [{ start: 8, end: 40 }, { start: 70, end: 100 }]);
});

test('bytes written before a DISCARD are in the backing a draw after it reads', ()=>{
    // A program fills the end of its ring, wraps the ring with DISCARD for the
    // next batch, and only then draws what it filled first. Its memory still
    // holds those bytes, and a driver hands back the same memory once the GPU
    // is done with it, so the backing the draw reads has to hold them too --
    // a pooled one holds whatever its last generation left.
    const { gpu, dynamic, endFrame } = carrying(4096);
    fill(dynamic, 0, 4096, LockFlags.DISCARD, 0x22);
    endFrame();
    fill(dynamic, 3072, 512, LockFlags.NOOVERWRITE, 0x55);
    const before = gpu.of('writeBuffer').length;
    fill(dynamic, 0, 256, LockFlags.DISCARD, 0x66);
    const read = dynamic.gpu;
    endFrame();

    assert.ok(read.bytes.subarray(3072, 3584).every((/** @type {number} */ byte)=>byte === 0x55),
        'the range written before the discard');
    assert.ok(read.bytes.subarray(0, 256).every((/** @type {number} */ byte)=>byte === 0x66),
        'and the one written after it');
    const uploads = gpu.of('writeBuffer').slice(before);
    assert.equal(uploads.reduce((sum, one)=>sum + one.size, 0), 512 + 256,
        'each range travels once; the rest is a copy on the GPU');
});
