/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex attribute bindings (OpenGL 4.3 section 10.3.1, 4.4's multiple
 * vertex buffers, 4.5's vertex array objects by name): what an attribute
 * reads through its binding point, the pointer calls as the model's
 * shorthand, the queries, the errors, and the state kept per object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { GL_EXTENSIONS } from './extensions.js';
import { instanceElements, planLayout } from './gpu-layout.js';

/** @returns {{ gl: any, floats: (at: number, values: number[]) => void }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {string[]} */
    const said = [];
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    }, keepPrimitives: true, divergence: d=>said.push(d) });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return {
        gl: Object.assign(gl, { said }),
        floats: (at, values)=>values.forEach((v, i)=>view.setFloat32(at + i * 4, v, true)),
    };
}

/** @param {any} gl @param {number[]} values @returns {number} a buffer of the floats */
function floatBuffer(gl, values){
    const [name] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, values.length * 4,
        new Uint8Array(new Float32Array(values).buffer), GL.STATIC_DRAW);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    return name;
}

/** @param {any} gl @returns {number[][]} each drawn vertex's position, x and y */
const positions = gl=>gl.submittedPrimitives.flatMap((/** @type {any} */ p)=>
    p.vertices.map((/** @type {any} */ v)=>v.position.slice(0, 2)));

test('an attribute reads its binding point\'s buffer at the point\'s offset plus its own', ()=>{
    const { gl } = fixture();
    // Interleaved: x, y, then a value the draw does not read.
    const name = floatBuffer(gl, [9, 9, 9, 0, 0, 7, 1, 0, 7, 0, 1, 7]);
    gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 0, 'float');
    gl.glBindVertexBuffer(3, name, 12, 12);
    gl.glVertexAttribBinding(0, 3);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(positions(gl), [[0, 0], [1, 0], [0, 1]]);

    // The relative offset moves the attribute within the element.
    gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 4, 'float');
    gl.glDrawArrays(GL.TRIANGLES, 0, 1);
    assert.deepEqual(positions(gl).at(-1), [0, 7]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(0, GL.VERTEX_ATTRIB_RELATIVE_OFFSET), [4]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(0, GL.VERTEX_ATTRIB_BINDING), [3]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_BUFFER, 3), [name]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_OFFSET, 3), [12]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_STRIDE, 3), [12]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_STRIDE, 5), [16], 'a new point\'s');
    assert.ok(GL_EXTENSIONS.GL_ARB_vertex_attrib_binding.includes('glVertexAttribBinding'));
});

test('a point\'s stride of zero reads one element for every vertex, on the processor and as'
    + ' a constant slot for the device', ()=>{
    const { gl } = fixture();
    const name = floatBuffer(gl, [0, 0, 1, 0, 0, 1]);
    gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 0, 'float');
    gl.glBindVertexBuffer(0, name, 8, 0);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.deepEqual(positions(gl), [[1, 0], [1, 0], [1, 0]]);
    // The conventional pointer call is the shorthand too: tightly packed again.
    gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
    gl.glVertexPointer(2, GL.FLOAT, 0, 0);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.deepEqual(positions(gl).slice(3), [[0, 0], [1, 0], [0, 1]]);
    gl.glBindVertexBuffer(0, name, 8, 0);

    const layout = planLayout([{ name: 'position', normalised: false,
        pointer: { size: 2, type: GL.FLOAT, stride: 0, literalStride: 0, pointer: 8,
            buffer: name } }]);
    assert.ok(layout);
    const [slot] = layout.slots;
    assert.equal(slot.constant, true);
    assert.ok(slot.divisor > 0, 'read by instance');
    assert.equal(slot.stride, 8, 'one element wide');
    assert.deepEqual(instanceElements(slot, 3, 2), [0, 0, 0], 'element zero for each instance');
    // A pointer call's zero is tightly packed.
    const packed = planLayout([{ name: 'position', normalised: false,
        pointer: { size: 2, type: GL.FLOAT, stride: 0, pointer: 8, buffer: name } }]);
    assert.equal(packed?.slots[0].stride, 8);
    assert.equal(packed?.slots[0].divisor, 0);
});

test('the pointer calls are the shorthand: an attribute sharing a point follows them', ()=>{
    const f = fixture();
    const { gl } = f;
    f.floats(0x100, [0, 0, 5, 5, 1, 0, 6, 6, 0, 1, 7, 7]);
    // Attribute 0 at offset 8 on attribute 1's point.
    gl.glVertexAttribPointerARB(1, 2, GL.FLOAT, 0, 16, 0x100);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_STRIDE, 1), [16]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_OFFSET, 1), [0x100]);
    gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 8, 'float');
    gl.glVertexAttribBinding(0, 1);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.deepEqual(positions(gl), [[5, 5], [6, 6], [7, 7]]);
    // Moving attribute 1's pointer moves attribute 0 too.
    gl.glVertexAttribPointerARB(1, 2, GL.FLOAT, 0, 0, 0x108);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_STRIDE, 1), [8], 'the effective one');
    assert.deepEqual(gl.glGetVertexAttribfvARB(1, GL.VERTEX_ATTRIB_ARRAY_STRIDE_ARB), [0],
        'the attribute\'s as given');
    gl.glDrawArrays(GL.TRIANGLES, 0, 2);
    assert.deepEqual(positions(gl).slice(3), [[1, 0], [6, 6]]);
    // glVertexAttribPointer puts attribute 0 back on its own point.
    gl.glVertexAttribPointerARB(0, 2, GL.FLOAT, 0, 0, 0x100);
    assert.deepEqual(gl.glGetVertexAttribfvARB(0, GL.VERTEX_ATTRIB_BINDING), [0]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(0, GL.VERTEX_ATTRIB_RELATIVE_OFFSET), [0]);

    // glVertexAttribDivisor is the point's divisor, and every sharer's.
    gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 0, 'float');
    gl.glVertexAttribBinding(0, 1);
    gl.glVertexAttribDivisor(1, 2);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_DIVISOR, 1), [2]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(0, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [2]);
    gl.glVertexBindingDivisor(1, 3);
    assert.deepEqual(gl.glGetVertexAttribfvARB(1, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [3]);
    // A pointer call puts attribute 6 back on its own point, and its divisor.
    gl.glVertexAttribBinding(6, 1);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [3]);
    gl.glVertexAttribPointerARB(6, 2, GL.FLOAT, 0, 0, 0x100);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [0]);
});

test('the format calls set an attribute\'s kind, and the binding calls refuse what 10.3.1'
    + ' lists', ()=>{
    const { gl } = fixture();
    gl.vertexAttribFormat(6, 3, GL.SHORT, 0, 2, 'int');
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_INTEGER), [1]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_TYPE_ARB), [GL.SHORT]);
    gl.vertexAttribFormat(6, 2, GL.DOUBLE, 0, 0, 'long');
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_LONG), [1]);
    assert.equal(gl.said.filter((/** @type {string} */ d)=>/64-bit/.test(d)).length, 1,
        'a double attribute says it is single precision');

    /** @param {() => void} call @param {number} error @param {string} what */
    const refused = (call, error, what)=>{
        call();
        assert.equal(gl.glGetError(), error, what);
    };
    refused(()=>gl.vertexAttribFormat(16, 4, GL.FLOAT, 0, 0, 'float'), GL.INVALID_VALUE,
        'an attribute past the last');
    refused(()=>gl.vertexAttribFormat(0, 5, GL.FLOAT, 0, 0, 'float'), GL.INVALID_VALUE, 'size');
    refused(()=>gl.vertexAttribFormat(0, 4, GL.FLOAT, 0, 2048, 'float'), GL.INVALID_VALUE,
        'past the most relative offset');
    refused(()=>gl.vertexAttribFormat(0, 4, GL.FLOAT, 0, 0, 'int'), GL.INVALID_ENUM,
        'a float for the integer form');
    refused(()=>gl.vertexAttribFormat(0, 4, GL.FLOAT, 0, 0, 'long'), GL.INVALID_ENUM,
        'only doubles for the 64-bit form');
    refused(()=>gl.vertexAttribFormat(0, 3, GL.INT_2_10_10_10_REV, 1, 0, 'float'),
        GL.INVALID_OPERATION, 'a packed type takes four');
    refused(()=>gl.glVertexAttribBinding(0, 16), GL.INVALID_VALUE, 'a point past the last');
    refused(()=>gl.glVertexAttribBinding(16, 0), GL.INVALID_VALUE, 'an attribute past the last');
    refused(()=>gl.glBindVertexBuffer(16, 0, 0, 4), GL.INVALID_VALUE, 'a point past the last');
    refused(()=>gl.glBindVertexBuffer(0, 0, -4, 4), GL.INVALID_VALUE, 'a negative offset');
    refused(()=>gl.glBindVertexBuffer(0, 0, 0, 2052), GL.INVALID_VALUE, 'past the most stride');
    refused(()=>gl.glBindVertexBuffer(0, 77, 0, 4), GL.INVALID_OPERATION, 'a name never made');
    const [made] = gl.glGenBuffersARB(1);
    refused(()=>gl.glBindVertexBuffer(0, made, 0, 4), GL.NO_ERROR, 'a name glGenBuffers gave');
    assert.equal(gl.glIsBufferARB(made), GL.TRUE, 'is an object now');
    refused(()=>gl.glVertexBindingDivisor(16, 1), GL.INVALID_VALUE, 'a point past the last');
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_ATTRIB_BINDINGS), [16]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_ATTRIB_RELATIVE_OFFSET), [2047]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_ATTRIB_STRIDE), [2048]);
});

test('glBindVertexBuffers binds a run, refusing an entry alone, and with no buffers resets', ()=>{
    const { gl } = fixture();
    const [a, b] = [floatBuffer(gl, [0]), floatBuffer(gl, [0])];
    gl.glBindVertexBuffers(2, 3, [a, 99, b], [4, 8, 12], [16, 20, 24]);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'the second\'s name');
    assert.deepEqual([2, 3, 4].map(k=>gl.glGetIntegeri_v(GL.VERTEX_BINDING_BUFFER, k)[0]),
        [a, 0, b], 'the others bound');
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_OFFSET, 4), [12]);
    gl.glBindVertexBuffers(2, 3, null, [], []);
    assert.deepEqual([2, 4].map(k=>[GL.VERTEX_BINDING_BUFFER, GL.VERTEX_BINDING_OFFSET,
        GL.VERTEX_BINDING_STRIDE].map(q=>gl.glGetIntegeri_v(q, k)[0])), [[0, 0, 16], [0, 0, 16]]);
    gl.glBindVertexBuffers(15, 2, null, [], []);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'past the last point');
});

test('the bindings are vertex array object state, and saved with the client vertex arrays',
    ()=>{
        const f = fixture();
        const { gl } = f;
        // An object whose vertex array reads one element for every vertex...
        const [constant, plain] = gl.glGenVertexArrays(2);
        gl.glBindVertexArray(constant);
        gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 0, 'float');
        gl.glBindVertexBuffer(0, 0, 0x200, 0);
        // ...and one that reads the client array it starts with (four floats
        // at address zero), tightly packed.
        gl.glBindVertexArray(plain);
        f.floats(0, [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]);
        gl.glEnableClientState(GL.VERTEX_ARRAY);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        assert.deepEqual(positions(gl), [[0, 0], [1, 0], [0, 1]], 'not the other\'s stride');
        gl.glBindVertexArray(0);

        const name = floatBuffer(gl, [0]);
        const [vao] = gl.glGenVertexArrays(1);
        gl.glBindVertexArray(vao);
        gl.glBindVertexBuffer(2, name, 4, 8);
        gl.vertexAttribFormat(1, 2, GL.FLOAT, 0, 4, 'float');
        gl.glVertexAttribBinding(1, 2);
        gl.glBindVertexArray(0);
        assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_BUFFER, 2), [0], 'the default\'s');
        assert.deepEqual(gl.glGetVertexAttribfvARB(1, GL.VERTEX_ATTRIB_BINDING), [1]);
        gl.glBindVertexArray(vao);
        assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_BUFFER, 2), [name]);
        assert.deepEqual(gl.glGetVertexAttribfvARB(1, GL.VERTEX_ATTRIB_BINDING), [2]);

        gl.glPushClientAttrib(GL.CLIENT_VERTEX_ARRAY_BIT);
        gl.glBindVertexBuffer(2, 0, 0, 4);
        gl.glVertexAttribBinding(1, 5);
        gl.glPopClientAttrib();
        assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_BUFFER, 2), [name]);
        assert.deepEqual(gl.glGetVertexAttribfvARB(1, GL.VERTEX_ATTRIB_BINDING), [2]);

        // Not compiled: made as it is reached.
        const list = gl.glGenLists(1);
        gl.glNewList(list, GL.COMPILE);
        gl.glVertexBindingDivisor(2, 4);
        gl.glEndList();
        assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_DIVISOR, 2), [4]);
    });

test('the named calls (4.5) set an object\'s state with another one bound', ()=>{
    const { gl } = fixture();
    const name = floatBuffer(gl, [0]);
    const [vao] = gl.glCreateVertexArrays(1);
    assert.equal(gl.glIsVertexArray(vao), GL.TRUE, 'an object without a bind');
    gl.namedVertexArray('glBindVertexBuffer', vao, [1, name, 8, 12]);
    gl.namedVertexArray('vertexAttribFormat', vao, [7, 3, GL.FLOAT, 0, 0, 'float']);
    gl.namedVertexArray('glEnableVertexAttribArrayARB', vao, [7]);
    gl.glVertexArrayElementBuffer(vao, name);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_BINDING), [0], 'the binding put back');
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_BUFFER, 1), [0]);
    assert.deepEqual(gl.getVertexArray(vao, GL.ELEMENT_ARRAY_BUFFER_BINDING), [name]);
    assert.deepEqual(gl.getVertexArrayIndexed(vao, 7, GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB, false),
        [1]);
    assert.deepEqual(gl.getVertexArrayIndexed(vao, 7, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB, false),
        [3]);
    assert.deepEqual(gl.getVertexArrayIndexed(vao, 1, GL.VERTEX_BINDING_OFFSET, true), [8]);
    gl.getVertexArrayIndexed(vao, 1, GL.VERTEX_BINDING_OFFSET, false);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'the offset only in 64 bits');
    gl.getVertexArray(vao, GL.VERTEX_ARRAY_BINDING);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.getVertexArrayIndexed(vao, 7, GL.CURRENT_VERTEX_ATTRIB_ARB, false);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not an array\'s state');
    gl.glBindVertexArray(vao);
    assert.deepEqual(gl.glGetIntegeri_v(GL.VERTEX_BINDING_STRIDE, 1), [12]);
    assert.deepEqual(gl.glGetIntegerv(GL.ELEMENT_ARRAY_BUFFER_BINDING), [name]);
    gl.glBindVertexArray(0);

    gl.namedVertexArray('glBindVertexBuffer', 42, [1, name, 0, 4]);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not an object');
    gl.glVertexArrayElementBuffer(vao, 77);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not a buffer');
});

test('on the device a zero stride is an instance-stepped buffer of the one element', async()=>{
    const { createGpuRenderer } = await import('./gpu.js');
    const { createBackend } = await import('../webgpu/backend.js');
    const { createFakeDevice } = await import('../webgpu/internal/fake-device.js');
    const gpu = createFakeDevice();
    const renderer = createGpuRenderer({
        backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} }),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
    });
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    const name = floatBuffer(gl, [0, 0, 1, 0, 0, 1]);
    // Attribute 0 is the vertex array: one position for every vertex.
    gl.vertexAttribFormat(0, 2, GL.FLOAT, 0, 0, 'float');
    gl.glBindVertexBuffer(0, name, 8, 0);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    renderer.present(gl);
    await renderer.settled();
    const buffers = gpu.of('createRenderPipeline').flatMap((/** @type {any} */ call)=>
        call.descriptor.vertex.buffers ?? []);
    assert.ok(buffers.some((/** @type {any} */ b)=>b.stepMode === 'instance'
        && b.arrayStride === 8), 'one element wide, stepped by instance');
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});
