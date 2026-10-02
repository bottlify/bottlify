/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createModelRenderer } from './gpu-model.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/**
 * A context over one memory whose every read is logged, on the renderer
 * given.
 *
 * @param {Uint8Array} bytes @param {any} renderer
 */
function contextOn(bytes, renderer){
    /** @type {string[]} */
    const reads = [];
    /** @param {number} at @param {number} length */
    const read = (at, length)=>{
        reads.push(`${at}+${length}`);
        return bytes.subarray(at, at + length);
    };
    /** @type {any} */
    const context = createGlContext({
        memory: { read, window: read, write: ()=>{} },
        gpu: renderer,
        keepPrimitives: true,
    });
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    return { context, reads };
}

function realRenderer(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    return createGpuRenderer({ backend, createSampler: ()=>({}) });
}

/** The program's memory: positions, colours and indices where the draws below look. */
function memory(){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 64; i++)
    {
        view.setFloat32(0x100 + i * 12, i, true);
        view.setFloat32(0x104 + i * 12, i * 2, true);
        view.setFloat32(0x108 + i * 12, 0, true);
        view.setUint32(0x800 + i * 4, 0xff00ff00 | i, true);
    }
    [7, 3, 9, 4, 5, 6].forEach((index, i)=>view.setUint32(0x1000 + i * 4, index, true));
    [2, 0, 1].forEach((index, i)=>view.setUint16(0x1100 + i * 2, index, true));
    return bytes;
}

/**
 * The draws a context is put through: client arrays, client indices, a
 * buffer object alone and beside a client array, an element buffer, a lit
 * draw, a stride the device cannot bind, a deleted buffer object.
 *
 * @param {any} context
 */
function draws(context){
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 12, 0x100);
    context.glDrawArrays(GL.TRIANGLES, 3, 6);
    context.glEnableClientState(GL.COLOR_ARRAY);
    context.glColorPointer(4, GL.UNSIGNED_BYTE, 4, 0x800);
    context.glDrawElements(GL.TRIANGLES, 6, GL.UNSIGNED_INT, 0x1000);
    context.glDrawElements(GL.TRIANGLE_STRIP, 3, GL.UNSIGNED_SHORT, 0x1100);

    const [vertices, elements] = context.glGenBuffersARB(2);
    context.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 64 * 12, 0x100, GL.STATIC_DRAW);
    context.glVertexPointer(3, GL.FLOAT, 12, 0);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    context.glDrawElements(GL.TRIANGLES, 6, GL.UNSIGNED_INT, 0x1000);
    context.glDisableClientState(GL.COLOR_ARRAY);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    context.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, elements);
    context.glBufferDataARB(GL.ELEMENT_ARRAY_BUFFER, 24, 0x1000, GL.STATIC_DRAW);
    context.glDrawElements(GL.TRIANGLES, 6, GL.UNSIGNED_INT, 0);
    context.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, 0);

    context.glEnable(GL.LIGHTING);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    context.glDisable(GL.LIGHTING);

    context.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    context.glVertexPointer(3, GL.SHORT, 6, 0x100);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);

    context.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    context.glVertexPointer(3, GL.FLOAT, 12, 0);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    context.glDeleteBuffersARB([vertices]);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
}

test('a context on the model renderer takes the draws gpu.js takes and reads what it reads', ()=>{
    const real = contextOn(memory(), realRenderer());
    const model = contextOn(memory(), createModelRenderer());
    draws(real.context);
    draws(model.context);
    assert.ok(real.context.submittedPrimitives.length > 0,
        'some draws were assembled on the processor');
    assert.deepEqual(model.context.submittedPrimitives, real.context.submittedPrimitives);
    assert.deepEqual(model.reads, real.reads);
    assert.ok(real.reads.includes(`${0x100 + 3 * 12}+${6 * 12}`),
        'the client vertices a draw reaches were read');
});

test('the model renderer presents the drawable\'s size, and nothing before attach', ()=>{
    const model = createModelRenderer();
    const context = {};
    assert.equal(model.present(context), null);
    model.attach(context, { width: 0, height: 20 });
    assert.deepEqual(model.present(context), { width: 1, height: 20 });
});
