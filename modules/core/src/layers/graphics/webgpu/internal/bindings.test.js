/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingCache, createUniformPool, dynamicOffsetsOf, resourceId } from './bindings.js';
import { createFakeDevice } from './fake-device.js';

test('resource identity is stable per object and distinct between objects', ()=>{
    const a = {};
    const b = {};
    assert.equal(resourceId(a), resourceId(a));
    assert.notEqual(resourceId(a), resourceId(b));
});

test('an identical group is built once and reused inside one pass', ()=>{
    const gpu = createFakeDevice();
    const cache = createBindingCache({ device: gpu.device });
    const layout = gpu.device.createBindGroupLayout({});
    const view = {};
    const entries = ()=>[{ binding: 0, resource: view }];

    const first = cache.get(layout, entries(), 'material');
    const second = cache.get(layout, entries(), 'material');

    assert.equal(first, second);
    assert.equal(gpu.count('createBindGroup'), 1);
    assert.deepEqual(cache.stats(), { created: 1, reused: 1 });
});

test('the cache is keyed on buffer identity, not on the binding slot', ()=>{
    const gpu = createFakeDevice();
    const cache = createBindingCache({ device: gpu.device });
    const layout = gpu.device.createBindGroupLayout({});
    const one = gpu.device.createBuffer({});
    const other = gpu.device.createBuffer({});

    const first = cache.get(layout,
        [{ binding: 0, resource: { buffer: one, offset: 0, size: 64 } }]);
    const second = cache.get(layout,
        [{ binding: 0, resource: { buffer: other, offset: 0, size: 64 } }]);
    const shifted = cache.get(layout,
        [{ binding: 0, resource: { buffer: one, offset: 64, size: 64 } }]);

    assert.notEqual(first, second, 'a different buffer at the same slot is a different group');
    assert.notEqual(first, shifted, 'so is a different offset into the same buffer');
    assert.equal(gpu.count('createBindGroup'), 3);
});

test('a layout is mandatory, so nothing can fall back to an automatic one', ()=>{
    const gpu = createFakeDevice();
    const cache = createBindingCache({ device: gpu.device });

    assert.throws(()=>cache.get(null, [{ binding: 0, resource: {} }]), /explicit/);
    assert.throws(()=>cache.get('auto', [{ binding: 0, resource: {} }]), /explicit/);
});

test('a uniform pool lays each block at its own offset of one ring, as bytes', ()=>{
    // Unit. One buffer rewritten per draw would show every draw in a pass the
    // last write; one buffer with a block per offset shows each draw its own,
    // and a group that names the buffer names nothing that changes per draw.
    const gpu = createFakeDevice();
    const pool = createUniformPool({ device: gpu.device, queue: gpu.queue });

    const first = pool.allocate(new Uint8Array(64).fill(1));
    const second = pool.allocate(new Uint8Array(64).fill(2));

    assert.equal(first.buffer, second.buffer, 'one ring');
    assert.equal(first.offset, 0);
    assert.equal(second.offset, 0, 'the binding itself starts at zero');
    assert.equal(first.dynamicOffset, 0);
    assert.equal(second.dynamicOffset, 256, 'the next block, at the alignment');
    assert.equal(first.size, 64);
    assert.equal(gpu.count('writeBuffer'), 0, 'nothing written before the flush');
    pool.flush();
    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 1, 'both blocks in one write, not a write a block');
    assert.equal(writes[0].bufferOffset, 0);
    const ring = first.buffer.bytes;
    assert.equal(ring[0], 1);
    assert.equal(ring[256], 2);
    assert.equal(ring[128], 0, 'the gap between blocks is not written with anything');
    pool.flush();
    assert.equal(gpu.count('writeBuffer'), 1, 'a flush with nothing laid writes nothing');
    assert.deepEqual(dynamicOffsetsOf([{ binding: 0, resource: second }]), [256]);
    assert.equal(dynamicOffsetsOf([{ binding: 1, resource: {} }]), undefined,
        'a view carries no offset');
});

test('the ring wraps rather than growing, and a block larger than it gets a larger ring', ()=>{
    const gpu = createFakeDevice();
    const pool = createUniformPool({ device: gpu.device, queue: gpu.queue, capacity: 512 });

    pool.allocate(new Uint8Array(64));
    pool.allocate(new Uint8Array(64));
    const wrapped = pool.allocate(new Uint8Array(64).fill(3));
    assert.equal(wrapped.dynamicOffset, 0,
        'back to the start: the queue orders the write after the submits before it');
    assert.equal(gpu.count('writeBuffer'), 1, 'what was laid before the wrap is written first');
    pool.flush();
    assert.equal(wrapped.buffer.bytes[0], 3);
    assert.equal(gpu.count('createBuffer'), 1);

    const large = pool.allocate(new Uint8Array(1024));
    assert.equal(gpu.count('createBuffer'), 2, 'a ring the block fits');
    assert.ok(gpu.of('createBuffer')[1].descriptor.size >= 1024);
    assert.equal(large.dynamicOffset, 0);
    assert.deepEqual(pool.stats(), { created: 2, reused: 4, writes: 2 });
});
