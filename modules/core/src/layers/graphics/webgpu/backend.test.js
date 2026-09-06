/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from './backend.js';
import { createFakeDevice } from './internal/fake-device.js';

/** @param {any} [options] */
function harness(options = {}){
    const gpu = createFakeDevice(options.fake);
    /** @type {any[]} */
    const presented = [];
    let clock = 0;
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: frame=>presented.push(frame),
        now: ()=>{
            clock += 1;
            return clock;
        },
        ...options.backend,
    });
    return { gpu, backend, presented };
}

/** @param {any} backend @param {number} [size] */
const target = (backend, size = 256)=>backend.createSurface({
    width: size,
    height: size,
    format: 'rgba8unorm',
    label: `target-${size}`,
});

test('a frame is one encoder and one submit, however many passes it has', ()=>{
    const { gpu, backend } = harness();
    const a = target(backend, 256);
    const b = target(backend, 128);

    const frame = backend.beginFrame();
    frame.beginPass({ target: a });
    frame.beginPass({ target: b });
    frame.beginPass({ target: a });
    frame.end();

    assert.equal(gpu.count('createCommandEncoder'), 1,
        'a target change is a new pass on the same encoder');
    assert.equal(gpu.count('beginRenderPass'), 3);
    assert.equal(gpu.count('endPass'), 3, 'every pass was closed');
    assert.equal(gpu.count('submit'), 1);
});

test('a second submit inside a frame cannot be expressed', ()=>{
    const { gpu, backend } = harness();

    const frame = backend.beginFrame();
    frame.beginPass({ target: target(backend) });

    const surface = [...Object.keys(backend), ...Object.keys(frame)];
    assert.ok(!surface.some(name=>/submit|finish|flush/i.test(name)),
        `nothing on the surface reaches the queue: ${surface.join(', ')}`);

    frame.end();
    assert.throws(()=>frame.end(), /already ended/);
    assert.throws(()=>frame.beginPass({ target: target(backend) }), /already ended/);
    assert.equal(gpu.count('submit'), 1);
});

test('two frames cannot be open at once', ()=>{
    const { backend } = harness();

    const frame = backend.beginFrame();
    assert.throws(()=>backend.beginFrame(), /already open/);
    frame.end();
    backend.beginFrame().end();
});

test('a target change resets the viewport and the scissor to the new target', ()=>{
    const { gpu, backend } = harness();
    const big = target(backend, 512);
    const small = target(backend, 128);

    const frame = backend.beginFrame();
    const first = frame.beginPass({ target: big });
    first.setViewport({ x: 0, y: 0, width: 64, height: 64 });
    const second = frame.beginPass({ target: small });
    frame.end();

    const viewports = gpu.of('setViewport').map(call=>call.rect);
    assert.deepEqual(viewports, [
        [0, 0, 512, 512, 0, 1],
        [0, 0, 64, 64, 0, 1],
        [0, 0, 128, 128, 0, 1],
    ], 'a downscale viewport does not stay latched on the next pass');
    assert.deepEqual(gpu.of('setScissorRect').map(call=>call.rect),
        [[0, 0, 512, 512], [0, 0, 64, 64], [0, 0, 128, 128]]);
    assert.deepEqual(second.viewport.scale, [2 / 128, -2 / 128],
        'and the vertex-stage half of the contract was reset with it');
});

test('the two halves of the viewport travel together', ()=>{
    const { gpu, backend } = harness();

    const frame = backend.beginFrame();
    const pass = frame.beginPass({ target: target(backend, 256) });
    pass.setViewport({ x: 32, y: 16, width: 64, height: 32 });
    frame.end();

    const last = gpu.of('setViewport').pop();
    assert.deepEqual(last.rect, [32, 16, 64, 32, 0, 1]);
    assert.deepEqual(pass.viewport.offset, [-32, -16]);
    assert.deepEqual(pass.viewport.scale, [2 / 64, -2 / 32]);
});

test('the binding cache does not survive a pass boundary', ()=>{
    const { gpu, backend } = harness();
    const layout = backend.createBindGroupLayout({ entries: [] });
    const view = {};
    const entries = ()=>[{ binding: 0, resource: view }];

    const frame = backend.beginFrame();
    const first = frame.beginPass({ target: target(backend) });
    first.setBindings(0, layout, entries());
    first.setBindings(0, layout, entries());
    assert.equal(gpu.count('createBindGroup'), 1, 'reused inside the pass');

    frame.beginPass({ target: target(backend) }).setBindings(0, layout, entries());
    assert.equal(gpu.count('createBindGroup'), 2,
        'a group carried across a pass boundary silently stops drawing');
    frame.end();
});

test('two draws in one pass with different uniform blocks get different buffers', ()=>{
    const { gpu, backend } = harness();
    const layout = backend.createBindGroupLayout({ entries: [] });

    const frame = backend.beginFrame();
    const pass = frame.beginPass({ target: target(backend) });

    const first = pass.uniforms(new Uint8Array(64).fill(1));
    pass.setBindings(0, layout, [{ binding: 0, resource: first }]);
    pass.draw(3);
    const second = pass.uniforms(new Uint8Array(64).fill(2));
    pass.setBindings(0, layout, [{ binding: 0, resource: second }]);
    pass.draw(3);
    frame.end();

    assert.notEqual(first.buffer, second.buffer, 'or every draw in the pass shows the last write');
    const groups = gpu.of('setBindGroup').map(call=>call.group);
    assert.notEqual(groups[0], groups[1],
        'and the cache keyed on buffer identity built two groups');
    assert.equal(gpu.count('createBindGroup'), 2);
});

test('a pipeline with an automatic bind-group layout is refused', ()=>{
    const { backend } = harness();

    assert.throws(()=>backend.createRenderPipeline({ layout: 'auto', vertex: {} }), /explicit/);
    assert.throws(()=>backend.createRenderPipeline({ vertex: {} }), /explicit/);
    const layout = backend.createPipelineLayout({ bindGroupLayouts: [] });
    assert.ok(backend.createRenderPipeline({ layout, vertex: {} }));
});

test('dirty buffers are uploaded once, before the frame is submitted', ()=>{
    const { gpu, backend } = harness();
    const vertices = backend.createDynamicBuffer({ size: 1024, usage: 0, label: 'vertices' });

    const frame = backend.beginFrame();
    const pass = frame.beginPass({ target: target(backend) });
    const lock = vertices.lock(0, 32, backend.LockFlags.DISCARD);
    lock.data.fill(9);
    vertices.unlock(lock);
    pass.setVertexBuffer(0, vertices);
    pass.draw(3);
    frame.end();

    const order = gpu.calls.map(call=>call.op);
    const write = order.lastIndexOf('writeBuffer');
    assert.ok(write >= 0 && write < order.indexOf('submit'), 'the bytes are on the queue first');
    assert.equal(gpu.count('writeBuffer'), 1);
    assert.equal(gpu.of('setVertexBuffer')[0].buffer, vertices.gpu,
        'the draw was recorded against the buffer generation it will read');
});

test('a finished frame leaves only through the presentation path', ()=>{
    const { backend, presented } = harness();
    const chain = backend.createSwapChain({ width: 320, height: 240, format: 'rgba8unorm' });

    const idle = backend.beginFrame();
    idle.end();
    assert.equal(presented.length, 0, 'a frame that presented nothing hands nothing over');

    const frame = backend.beginFrame();
    const surface = chain.acquire();
    frame.beginPass({ target: surface });
    frame.present(surface);
    frame.end();

    assert.equal(presented.length, 1);
    assert.equal(presented[0].surface, surface);
    assert.equal(backend.lastPresented(), presented[0],
        'a read-back has the composed frame available and no reason to go round it');
});

test('a swap chain rotates its colour targets', ()=>{
    const { backend } = harness();
    const chain = backend.createSwapChain({
        width: 64,
        height: 64,
        format: 'rgba8unorm',
        count: 3,
    });

    const seen = [chain.acquire(), chain.acquire(), chain.acquire(), chain.acquire()];
    assert.equal(seen[0], seen[3]);
    assert.equal(new Set(seen).size, 3);
});

test('a clear defaults to opaque, so a downscale chain cannot decay to nothing', ()=>{
    const { gpu, backend } = harness();

    const frame = backend.beginFrame();
    frame.beginPass({ target: target(backend), clear: true });
    frame.beginPass(
        { target: target(backend), clear: true, clearValue: { r: 0, g: 0, b: 0, a: 0 } });
    frame.end();

    const attachments = gpu.of('beginRenderPass').map(call=>call.descriptor.colorAttachments[0]);
    assert.equal(attachments[0].loadOp, 'clear');
    assert.equal(attachments[0].clearValue.a, 1);
    assert.equal(attachments[1].clearValue.a, 0, 'an explicit transparent clear is still allowed');
});

test('a texture upload outside a frame is encoded before that frame draws anything', ()=>{
    const { gpu, backend } = harness();
    const texture = gpu.device.createTexture({ label: 'atlas' });

    backend.uploadTexture({
        texture,
        format: 'bc1-rgba-unorm',
        width: 16,
        height: 16,
        data: new Uint8Array(128),
    });
    assert.equal(gpu.count('copyBufferToTexture'), 0, 'there was no encoder to record it on');

    const frame = backend.beginFrame();
    frame.beginPass({ target: target(backend) });
    frame.end();

    const order = gpu.calls.map(call=>call.op);
    assert.equal(gpu.count('copyBufferToTexture'), 1);
    assert.ok(order.indexOf('copyBufferToTexture') < order.indexOf('beginRenderPass'),
        'a copy cannot be recorded inside a render pass');
});

test('the snapshot is deep enough to find a regression that is not in the top rows', ()=>{
    const { backend } = harness();
    const vertices = backend.createDynamicBuffer({ size: 4096, usage: 0, label: 'vertices' });
    const indices = backend.createDynamicBuffer({ size: 1024, usage: 0, label: 'indices' });
    const layout = backend.createBindGroupLayout({ entries: [] });

    for (let index = 0; index < 2; index++){
        const frame = backend.beginFrame();
        const pass = frame.beginPass({ target: target(backend) });
        for (const buffer of [vertices, indices])
        {
            const lock = buffer.lock(0, 64, backend.LockFlags.DISCARD);
            buffer.unlock(lock);
        }
        pass.setBindings(0, layout, [{ binding: 0, resource: pass.uniforms(new Uint8Array(16)) }]);
        pass.setBindings(0, layout,
            [{ binding: 0, resource: { buffer: vertices.gpu, offset: 0 } }]);
        pass.draw(3);
        frame.end();
    }

    const snapshot = backend.diagnostics();
    assert.equal(snapshot.frames, 2);
    assert.equal(snapshot.counters.submits, 2, 'one submit a frame is a number, not a promise');
    assert.equal(snapshot.counters.passes, 2);
    assert.equal(snapshot.counters.draws, 2);
    assert.equal(snapshot.counters.bufferUploads, 4);
    assert.equal(snapshot.counters.bufferUploadBytes, 4 * 64);
    assert.equal(snapshot.counters.bindGroupsCreated, 4);
    assert.deepEqual(snapshot.uploadsByLabel.vertices, { count: 2, bytes: 128 },
        'per-buffer rows, because the decisive row is rarely near the top');
    assert.deepEqual(snapshot.uploadsByLabel.indices, { count: 2, bytes: 128 });
    assert.equal(snapshot.recentFrames.length, 2);
    assert.equal(snapshot.recentFrames[1].draws, 1);
    assert.ok(snapshot.recentFrames[1].phases.passes >= 0, 'time is attributed by phase');
    assert.ok(snapshot.recentFrames[1].totalMs > 0);
});

test('the frame history is a ring, not a leak', ()=>{
    const { backend } = harness({ backend: { frameHistory: 3 } });

    for (let index = 0; index < 10; index++){
        backend.beginFrame().end();
    }

    const snapshot = backend.diagnostics();
    assert.equal(snapshot.frames, 10);
    assert.equal(snapshot.recentFrames.length, 3);
    assert.equal(snapshot.recentFrames[2].index, 9);
});
