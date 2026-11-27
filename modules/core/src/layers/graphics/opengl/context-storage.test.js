/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader storage buffers on a recording device (OpenGL 4.3 section 7.8): a
 * buffer block a compute or fragment stage reads and writes reaches the
 * buffer object bound to its binding point, word by word as std430 or
 * std140 lays it out; atomics on its members are WGSL's atomics; a read of
 * the buffer on this side waits for the device's bytes; and the binding
 * points, glShaderStorageBlockBinding and the limits answer as 4.3 says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { computeRig } from './compute-fixture.js';
import { GLSL_STORAGE_BINDING } from './glsl-wgsl.js';
import { STORAGE_LIMITS } from './glsl-storage.js';

const CS = `#version 430
layout(local_size_x = 4) in;
layout(std430, binding = 1) buffer Data { float scale; uint count; vec4 v[]; } d;
void main() {
    uint i = gl_GlobalInvocationID.x;
    if (int(i) < d.v.length()) { d.v[i] *= d.scale; }
    atomicAdd(d.count, 1u);
}`;

/** @param {any} r @returns {string} the compute module's WGSL */
const computeCode = r=>r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>
    m.descriptor.code).find((/** @type {string} */ text)=>text.includes('computeMain'));

/** @param {any} dispatched @param {number} binding */
const entryAt = (dispatched, binding)=>dispatched.groups[0].descriptor.entries
    .find((/** @type {any} */ e)=>e.binding === binding);

test('a storage block reaches the buffer bound to its point, atomically where it is changed so',
    async()=>{
        const r = computeRig();
        const { gl } = r;
        const made = r.program([[GL.COMPUTE_SHADER, CS]]);
        assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(made));
        gl.glUseProgram(made);
        const data = new Float32Array(4 + 4 * 4);
        data[0] = 2;
        const name = r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(data.buffer));
        gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 1, name);
        assert.deepEqual(gl.glGetIntegeri_v(GL.SHADER_STORAGE_BUFFER_BINDING, 1), [name]);
        gl.glDispatchCompute(1, 1, 1);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        await r.renderer.settled();
        // Replayed before the swap: what the pass writes is the device's
        // from the moment it is recorded.
        const [dispatched] = r.gpu.of('dispatchWorkgroups');
        assert.ok(dispatched, 'the pass was replayed without a swap');
        assert.deepEqual(r.divergences, []);
        const entry = entryAt(dispatched, GLSL_STORAGE_BINDING);
        assert.equal(entry.resource.offset, 0);
        assert.equal(entry.resource.size, data.byteLength);
        const words = new Float32Array(entry.resource.buffer.bytes.buffer,
            entry.resource.buffer.bytes.byteOffset, 4);
        assert.equal(words[0], 2, 'the buffer holds what the program stored');
        const code = computeCode(r);
        assert.match(code, /var<storage, read_write> gss0: array<atomic<u32>>/);
        assert.match(code, /atomicAdd\(&gss0\[1u\]/);
        assert.match(code, /arrayLength\(&gss0\) \* 4u - 16u\) \/ 16u/);
    });

test('a read of a buffer a shader wrote waits for the device\'s bytes', async()=>{
    const r = computeRig();
    const { gl } = r;
    gl.glUseProgram(r.program([[GL.COMPUTE_SHADER, CS]]));
    const name = r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(32));
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 1, name);
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    // What the shader would have written, put where the device holds it.
    const device = entryAt(dispatched, GLSL_STORAGE_BINDING).resource.buffer;
    device.bytes[4] = 7;
    const read = gl.glGetBufferSubDataARB(GL.SHADER_STORAGE_BUFFER, 4, 4);
    assert.ok(read instanceof Promise, 'the read waits');
    assert.deepEqual([...await read], [7, 0, 0, 0]);
    assert.deepEqual(r.divergences, []);
    // Read once, the bytes are this side's again until the next pass.
    assert.ok(!(gl.glGetBufferSubDataARB(GL.SHADER_STORAGE_BUFFER, 4, 4) instanceof Promise));
});

test('glShaderStorageBlockBinding moves a block to another point', async()=>{
    const r = computeRig();
    const { gl } = r;
    const made = r.program([[GL.COMPUTE_SHADER, CS]]);
    gl.glUseProgram(made);
    const index = gl.glGetProgramResourceIndex(made, GL.SHADER_STORAGE_BLOCK, 'Data');
    assert.equal(index, 0);
    assert.equal(gl.glGetProgramResourceIndex(made, GL.SHADER_STORAGE_BLOCK, 'Nothing'),
        GL.INVALID_INDEX);
    const first = r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(32));
    const second = r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(64));
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 1, first);
    gl.glBindBufferRange(GL.SHADER_STORAGE_BUFFER, 3, second, 0, 48);
    gl.glShaderStorageBlockBinding(made, index, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glShaderStorageBlockBinding(made, index, STORAGE_LIMITS.bindings);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the points');
    gl.glShaderStorageBlockBinding(made, 1, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no such block');
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    assert.equal(entryAt(dispatched, GLSL_STORAGE_BINDING).resource.size, 48,
        'the range bound to point 3');
});

test('the storage binding points and limits answer as 4.3 says', ()=>{
    const r = computeRig();
    const { gl } = r;
    const name = r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(1024));
    gl.glBindBufferRange(GL.SHADER_STORAGE_BUFFER, 0, name, 4, 16);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an offset off the alignment');
    gl.glBindBufferRange(GL.SHADER_STORAGE_BUFFER, 0, name, 256, 16);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegeri_v(GL.SHADER_STORAGE_BUFFER_START, 0), [256]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.SHADER_STORAGE_BUFFER_SIZE, 0), [16]);
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, STORAGE_LIMITS.bindings, name);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the points');
    assert.deepEqual(gl.glGetIntegerv(GL.SHADER_STORAGE_BUFFER_OFFSET_ALIGNMENT), [256]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_SHADER_STORAGE_BLOCKS), [0]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_COMPUTE_SHADER_STORAGE_BLOCKS), [8]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_FRAGMENT_SHADER_STORAGE_BLOCKS), [8]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_SHADER_STORAGE_BUFFER_BINDINGS), [8]);
    // A vertex stage has none.
    const vertex = r.program([[GL.VERTEX_SHADER, `#version 430
buffer B { vec4 p[]; };
void main() { gl_Position = p[gl_VertexID]; }`], [GL.FRAGMENT_SHADER,
        '#version 430\nout vec4 c; void main() { c = vec4(1.0); }']]);
    assert.deepEqual(gl.glGetProgramiv(vertex, GL.LINK_STATUS), [0]);
});

test('a fragment stage writes storage, in a draw that is replayed at once', async()=>{
    const r = computeRig();
    const { gl } = r;
    const made = r.program([[GL.VERTEX_SHADER, `#version 430
in vec4 position; void main() { gl_Position = position; }`], [GL.FRAGMENT_SHADER, `#version 430
layout(std430, binding = 0) buffer Hits { uint hits; int lowest; mat2 m; };
out vec4 c;
void main() { atomicAdd(hits, 1u); atomicMin(lowest, int(gl_FragCoord.x)); m[1] = vec2(1.0);
    c = vec4(1.0); }`]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    const name = r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(32));
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 0, name);
    r.bytes.set(new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]).buffer),
        0x1000);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.renderer.settled();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.equal(r.gpu.of('draw').length, 1, 'replayed without a swap');
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>text.includes('gss0'));
    // A signed minimum on a word: a compare-and-swap loop.
    assert.match(code, /atomicCompareExchangeWeak\(&gss0\[1u\]/);
    assert.match(code, /atomicStore\(&gss0\[4u\]/, 'm[1] is at 16 under std430');
    const layouts = r.gpu.of('createBindGroupLayout').map((/** @type {any} */ l)=>
        l.descriptor.entries).flat();
    const storage = layouts.find((/** @type {any} */ e)=>e.binding === GLSL_STORAGE_BINDING);
    assert.equal(storage.visibility, 2, 'the fragment stage\'s alone');
    assert.equal(storage.buffer.type, 'storage');
    assert.ok(gl.glGetBufferSubDataARB(GL.SHADER_STORAGE_BUFFER, 0, 4) instanceof Promise,
        'the draw wrote the buffer');
});
