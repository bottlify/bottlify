/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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

test('the binding cache survives a pass boundary and a frame boundary', ()=>{
    // A group names a layout, a view, a sampler and the uniform ring: nothing
    // that changes per draw, so the one made in the first pass is the one
    // bound in every pass after it. A group per draw per frame was a
    // descriptor churn the device did not always keep up with.
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
    assert.equal(gpu.count('createBindGroup'), 1, 'and across a pass');
    frame.end();
    backend.beginFrame().beginPass({ target: target(backend) }).setBindings(0, layout, entries());
    assert.equal(gpu.count('createBindGroup'), 1, 'and across a frame');
});

test('two draws in one pass with different uniform blocks share a group at two offsets', ()=>{
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

    assert.equal(first.buffer, second.buffer, 'one ring');
    assert.notEqual(first.dynamicOffset, second.dynamicOffset,
        'or every draw in the pass shows the last write');
    const bound = gpu.of('setBindGroup');
    assert.equal(bound[0].group, bound[1].group, 'one group, bound twice');
    assert.deepEqual(bound.map(call=>call.offsets), [[0], [256]], 'each at its own offset');
    assert.equal(gpu.count('createBindGroup'), 1);
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

test('a staging buffer for a mid-frame upload is destroyed once that frame submits, not before',
    ()=>{
        const { gpu, backend } = harness();
        const texture = gpu.device.createTexture({ label: 'atlas' });

        const frame = backend.beginFrame();
        backend.uploadTexture({
            texture, format: 'bc1-rgba-unorm', width: 16, height: 16, data: new Uint8Array(128),
        });
        assert.equal(gpu.count('destroy'), 0, 'the frame has not submitted yet');
        frame.end();

        assert.equal(gpu.count('destroy'), 1, 'freed once its frame is submitted');
        const order = gpu.calls.map(call=>call.op);
        assert.ok(order.indexOf('submit') < order.indexOf('destroy'),
            'destroyed after the submit, never before');
    });

test('a staging buffer for an upload between frames waits for the frame that encodes it',
    ()=>{
        const { gpu, backend } = harness();
        const texture = gpu.device.createTexture({ label: 'atlas' });

        backend.uploadTexture({
            texture, format: 'bc1-rgba-unorm', width: 16, height: 16, data: new Uint8Array(128),
        });
        assert.equal(gpu.count('destroy'), 0, 'no encoder has recorded the copy yet');

        const frame = backend.beginFrame();
        assert.equal(gpu.count('destroy'), 0, 'encoded into this frame, but not yet submitted');
        frame.end();
        assert.equal(gpu.count('destroy'), 1,
            'freed once this frame -- the one that encoded it -- submits');
    });

test('dispose() destroys the staging buffers of copies queued but never encoded into a frame',
    ()=>{
        const { gpu, backend } = harness();
        const texture = gpu.device.createTexture({ label: 'atlas' });

        backend.uploadTexture({
            texture, format: 'bc1-rgba-unorm', width: 16, height: 16, data: new Uint8Array(128),
        });
        assert.equal(gpu.count('destroy'), 0, 'queued between frames, nothing has encoded it yet');

        backend.dispose();
        assert.equal(gpu.count('destroy'), 1,
            'a process replacement with copies still queued does not leak their buffers');
    });

test('dispose() destroys the staging buffers of a frame that was opened and never ended', ()=>{
    const { gpu, backend } = harness();
    const texture = gpu.device.createTexture({ label: 'atlas' });

    backend.beginFrame();
    backend.uploadTexture({
        texture, format: 'bc1-rgba-unorm', width: 16, height: 16, data: new Uint8Array(128),
    });
    assert.equal(gpu.count('destroy'), 0, 'the frame has not submitted yet');

    backend.dispose();
    assert.equal(gpu.count('destroy'), 1,
        'a fault mid-frame does not leak the open frame\'s staging buffer');
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
    assert.equal(snapshot.counters.bindGroupsCreated, 3,
        'the uniform group once, and the vertex buffer once per generation');
    assert.equal(snapshot.counters.bindGroupsReused, 1,
        'the second frame bound the uniform group again');
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

/**
 * The pipeline tests below are the other kind: they assert the commands the
 * backend issued through the recording device, never the pixels a device would
 * produce. A real GPU's bytes are not reproducible across drivers, so a stored
 * image cannot be compared against one; what a device is *asked* to do is
 * exactly reproducible, and that is what is checked here. The formula itself is
 * checked byte-exactly against a software reference in `internal/reference.test.js`.
 */

/** A minimal fixed-function state: position and diffuse, no stages. */
const drawState = (over = {})=>({
    fvf: 0x142,
    vertexShader: 0,
    pixelShader: 0,
    targetFormat: 'rgba8unorm',
    depthTest: false,
    depthWrite: false,
    depthFunc: 8,
    cullMode: 1,
    blend: false,
    srcBlend: 5,
    destBlend: 6,
    blendOp: 1,
    colorWrite: 0xf,
    alphaTest: false,
    alphaFunc: 8,
    fogMode: 0,
    stages: [],
    ...over,
});

test('a pipeline is built from state, with an explicit layout and a checked shader', async()=>{
    const { gpu, backend } = harness();
    const built = await backend.pipelineFor(drawState());

    assert.ok(built.gpu, 'a pipeline came back');
    const descriptor = gpu.of('createRenderPipeline')[0].descriptor;
    assert.notEqual(descriptor.layout, 'auto',
        'an automatic layout drops a binding the shader did not use, and the draw vanishes');
    assert.equal(descriptor.vertex.entryPoint, 'vertexMain');
    assert.equal(descriptor.fragment.targets[0].format, 'rgba8unorm');
    // Every module is asked what the compiler thought; one that was rejected
    // still binds and still draws, wrongly.
    assert.equal(gpu.count('getCompilationInfo'), 1);
});

test('two draws with the same state compile one shader', async()=>{
    const { gpu, backend } = harness();

    await backend.pipelineFor(drawState());
    await backend.pipelineFor(drawState());

    assert.equal(gpu.count('createShaderModule'), 1);
    assert.equal(gpu.count('createRenderPipeline'), 1);
    assert.deepEqual(backend.diagnostics().pipelines, { built: 1, reused: 1, resident: 1 });
});

test('a draw that differs only in a later stage gets its own pipeline', async()=>{
    // The cascade at stage one selects a different fragment formula. A key that
    // folded only stage zero would hand both draws the pipeline built for the
    // first, and the second would render with the wrong formula and no error.
    const { gpu, backend } = harness();
    const stage = (over = {})=>({
        colorOp: 4, colorArg1: 2, colorArg2: 0,
        alphaOp: 4, alphaArg1: 2, alphaArg2: 0,
        texCoordIndex: 0,
        ...over,
    });
    const withTexture = { fvf: 0x142 | (2 << 8) };

    await backend.pipelineFor(drawState({ ...withTexture, stages: [stage(), stage()] }));
    await backend.pipelineFor(drawState({
        ...withTexture,
        stages: [stage(), stage({ texCoordIndex: 1 })],
    }));

    assert.equal(gpu.count('createRenderPipeline'), 2);
    assert.equal(backend.diagnostics().pipelines.built, 2);
});

test('a stage takes a texture and a sampler binding, declared not inferred', async()=>{
    const { gpu, backend } = harness();
    await backend.pipelineFor(drawState({
        fvf: 0x142 | (1 << 8),
        stages: [{
            colorOp: 4, colorArg1: 2, colorArg2: 0,
            alphaOp: 4, alphaArg1: 2, alphaArg2: 0,
            texCoordIndex: 0,
        }],
    }));

    const layout = gpu.of('createBindGroupLayout')[0].descriptor;
    assert.deepEqual(layout.entries.map((/** @type {any} */ e)=>e.binding), [0, 1, 2],
        'the uniform block, then a texture and a sampler for the one stage');
});

test('a bound vertex shader is refused rather than quietly given fixed function', async()=>{
    // Translating one is somebody else's job; producing a fixed-function
    // pipeline for it would draw the wrong geometry and report nothing.
    const { backend } = harness();
    await assert.rejects(
        ()=>backend.pipelineFor(drawState({ vertexShader: 7 })),
        /must be translated before it reaches the backend/,
    );
});

test('a surface can be six layers with a cube view, and defaults to one plain layer', ()=>{
    const { gpu, backend } = harness();
    const cube = backend.createSurface({
        width: 32, height: 32, format: 'rgba8unorm', layers: 6, dimension: 'cube', label: 'cube',
    });
    const plain = target(backend, 16);

    const [cubeTexture, plainTexture] = gpu.of('createTexture');
    assert.equal(cubeTexture.descriptor.size.depthOrArrayLayers, 6);
    assert.equal(plainTexture.descriptor.size.depthOrArrayLayers, 1);
    assert.equal(cube.layers, 6);
    assert.equal(plain.layers, 1);
    const [cubeView, plainView] = gpu.of('createView');
    assert.equal(cubeView.view.viewDescriptor.dimension, 'cube');
    assert.equal(plainView.view.viewDescriptor.dimension, undefined,
        'a plain surface leaves the view dimension to the texture');
});

test('a pass takes a stencil reference as dynamic state', ()=>{
    const { gpu, backend } = harness();
    const frame = backend.beginFrame();
    const pass = frame.beginPass({ target: target(backend) });
    pass.setStencilReference(0x80);
    frame.end();
    assert.deepEqual(gpu.of('setStencilReference').map((/** @type {any} */ c)=>c.reference),
        [0x80]);
});

test('a texture copy closes the pass it interrupts and records on the frame encoder', ()=>{
    const { gpu, backend } = harness();
    const a = target(backend, 64);
    const b = target(backend, 64);
    const frame = backend.beginFrame();
    frame.beginPass({ target: a });
    frame.copyTexture({ texture: a.texture }, { texture: b.texture, mipLevel: 0 },
        { width: 8, height: 8, depthOrArrayLayers: 1 });
    frame.end();
    const ops = gpu.calls.map((/** @type {any} */ c)=>c.op)
        .filter((/** @type {string} */ op)=>['beginRenderPass', 'endPass', 'copyTextureToTexture']
            .includes(op));
    assert.deepEqual(ops, ['beginRenderPass', 'endPass', 'copyTextureToTexture']);
    assert.equal(gpu.count('createCommandEncoder'), 1);
});

test('a snapshot keeps its staging buffer for the next one of the same size, and two in flight'
    + ' do not share it', async()=>{
    const { gpu, backend } = harness();
    const a = target(backend, 64);
    const stagings = ()=>gpu.calls.filter((/** @type {any} */ c)=>
        c.op === 'createBuffer' && c.descriptor.label === 'snapshot');

    // One after the other: the second read reuses the buffer the first
    // unmapped, so a program that reads its target back every frame does not
    // allocate a surface's worth of mappable memory every frame.
    let frame = backend.beginFrame();
    frame.beginPass({ target: a });
    const first = frame.snapshot(a);
    frame.end();
    await first();
    frame = backend.beginFrame();
    frame.beginPass({ target: a });
    const second = frame.snapshot(a);
    frame.end();
    await second();
    assert.equal(stagings().length, 1);

    // In flight together: the kept buffer is busy, so the second gets its own,
    // and whichever finishes second gives its buffer up.
    frame = backend.beginFrame();
    frame.beginPass({ target: a });
    const third = frame.snapshot(a);
    const fourth = frame.snapshot(a);
    frame.end();
    assert.equal(stagings().length, 2);
    await third();
    await fourth();
    frame = backend.beginFrame();
    frame.beginPass({ target: a });
    const fifth = frame.snapshot(a);
    frame.end();
    await fifth();
    assert.equal(stagings().length, 2, 'the kept one served the fifth');

    // A different size is a different buffer.
    const b = target(backend, 32);
    frame = backend.beginFrame();
    frame.beginPass({ target: b });
    const sixth = frame.snapshot(b);
    frame.end();
    await sixth();
    assert.equal(stagings().length, 3);
});

test('a snapshot still in flight at dispose() destroys its buffer instead of parking it',
    async()=>{
        // spareStaging is a place the *next* snapshot's buffer is served from;
        // once this instance is disposed nothing will ever read it again, so a
        // buffer parked there after dispose() is a leak for the rest of the run.
        const { gpu, backend } = harness();
        const a = target(backend, 64);

        const frame = backend.beginFrame();
        frame.beginPass({ target: a });
        const read = frame.snapshot(a);
        frame.end();

        const before = gpu.count('destroy');
        const pending = read();
        backend.dispose();
        await pending;

        assert.equal(gpu.count('destroy'), before + 1,
            'the in-flight snapshot destroys its buffer rather than parking it into spareStaging');
    });
