/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEPTH_READ_GROUP, DEPTH_WRITE_SHADER, MAX_GROUPS, depthReadGrid, depthReadShader,
    depthReadValues, depthWriteWords,
} from './depth.js';
import { createBackend } from '../backend.js';
import { createFakeDevice } from './fake-device.js';

test('a read covers every texel, in rows of groups a grid takes', ()=>{
    assert.deepEqual(depthReadGrid(640 * 480), [4800, 1, 1]);
    assert.deepEqual(depthReadGrid(1), [1, 1, 1]);
    const many = 4096 * 4096;
    const grid = depthReadGrid(many);
    assert.ok(grid[0] <= MAX_GROUPS);
    assert.ok(grid[0] * grid[1] * DEPTH_READ_GROUP >= many);
    // The shader numbers a texel by the same rows.
    assert.match(depthReadShader(false),
        new RegExp(`id\\.y \\* ${MAX_GROUPS * DEPTH_READ_GROUP}u`));
    assert.doesNotMatch(depthReadShader(false), /stencilTexture/);
    assert.match(depthReadShader(true), /words\[count \+ i\] = textureLoad\(stencilTexture/);
});

test('the words of a write are the width, the count, the depths and the stencils', ()=>{
    const words = depthWriteWords(2, Float32Array.of(0.5, 1, 0, 0.25), Uint8Array.of(1, 2, 3, 4));
    assert.deepEqual([...words.subarray(0, 2)], [2, 4]);
    assert.deepEqual([...new Float32Array(words.buffer, 8, 4)], [0.5, 1, 0, 0.25]);
    assert.deepEqual([...words.subarray(6)], [1, 2, 3, 4]);
    assert.equal(depthWriteWords(2, Float32Array.of(1, 1)).length, 4,
        'no stencil, no words for it');
    assert.match(DEPTH_WRITE_SHADER, /words\[2u \+ words\[1\] \+ texelOf\(position\)\]/);
    // And a read's words, back: the depths, then a stencil a word.
    const bytes = new Uint8Array(new Uint32Array([
        ...new Uint32Array(Float32Array.of(0.25, 1).buffer), 7, 0x1ff]).buffer);
    const values = depthReadValues(bytes, 2, true);
    assert.deepEqual([...values.depths], [0.25, 1]);
    assert.deepEqual(values.stencils && [...values.stencils], [7, 0xff]);
});

test('the backend reads a depth texture through its depth aspect, and its stencil through its'
    + ' own, and writes one by a pass over the depth alone, a bit of stencil a draw', async()=>{
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const surface = backend.createSurface({ width: 4, height: 2, format: 'depth24plus-stencil8',
        label: 'depth', usage: 0x10 | 0x04 });
    const built = await backend.depthPipelines('depth24plus-stencil8');
    assert.equal(built, await backend.depthPipelines('depth24plus-stencil8'), 'built once');
    assert.equal(built.write.bits.length, 8);
    const masks = gpu.of('createRenderPipeline')
        .map(call=>call.descriptor.depthStencil?.stencilWriteMask)
        .filter(mask=>mask !== undefined);
    assert.deepEqual(masks, [0, 1, 2, 4, 8, 16, 32, 64, 128], 'the depth, then a bit each');

    const frame = backend.beginFrame();
    const read = frame.readDepth(surface, built);
    frame.writeDepth(surface, depthWriteWords(4, new Float32Array(8), new Uint8Array(8)), built);
    frame.end();
    const views = gpu.of('createView').filter(call=>call.texture === surface.texture)
        .map(call=>call.view.viewDescriptor?.aspect ?? 'all');
    assert.ok(views.includes('depth-only') && views.includes('stencil-only'));
    const dispatched = gpu.of('dispatchWorkgroups');
    assert.deepEqual(dispatched.map(call=>call.grid), [[1, 1, 1]]);
    const pass = gpu.of('beginRenderPass').find(call=>call.descriptor.label === 'depth-write');
    assert.ok(pass);
    assert.deepEqual(pass.descriptor.colorAttachments, []);
    assert.equal(pass.descriptor.depthStencilAttachment.depthLoadOp, 'load');
    assert.equal(pass.descriptor.depthStencilAttachment.stencilLoadOp, 'clear');
    const values = await read();
    assert.equal(values.depths.length, 8);
    assert.equal(values.stencils?.length, 8);
});
