/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBindingCache, createUniformPool, resourceId } from './bindings.js';
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

test('a uniform pool hands each block its own buffer within a frame', ()=>{
    const gpu = createFakeDevice();
    const pool = createUniformPool({ device: gpu.device, queue: gpu.queue });

    const first = pool.allocate(new Uint8Array(64).fill(1));
    const second = pool.allocate(new Uint8Array(64).fill(2));

    assert.notEqual(first.buffer, second.buffer,
        'one buffer rewritten per draw would show every draw the last write');
    const writes = gpu.of('writeBuffer');
    assert.equal(writes.length, 2);
    assert.equal(writes[0].bytes[0], 1);
    assert.equal(writes[1].bytes[0], 2);
});

test('uniform buffers are recycled between frames rather than allocated per draw', ()=>{
    const gpu = createFakeDevice();
    const pool = createUniformPool({ device: gpu.device, queue: gpu.queue });

    pool.allocate(new Uint8Array(64));
    pool.allocate(new Uint8Array(64));
    assert.equal(gpu.count('createBuffer'), 2);

    pool.endFrame();
    pool.allocate(new Uint8Array(64));
    pool.allocate(new Uint8Array(64));
    assert.equal(gpu.count('createBuffer'), 2, 'the previous frame blocks came back');
    assert.deepEqual(pool.stats(), { created: 2, reused: 2 });
});

test('a block too large for a pooled buffer gets one of its own size', ()=>{
    const gpu = createFakeDevice();
    const pool = createUniformPool({ device: gpu.device, queue: gpu.queue, blockSize: 256 });

    const small = pool.allocate(new Uint8Array(16));
    assert.equal(gpu.of('createBuffer')[0].descriptor.size, 256, 'padded up to the alignment');
    assert.equal(small.size, 16);

    pool.allocate(new Uint8Array(1024));
    assert.equal(gpu.of('createBuffer')[1].descriptor.size, 1024);
});
