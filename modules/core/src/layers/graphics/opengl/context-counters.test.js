/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Atomic counters on a recording device (OpenGL 4.2 section 7.7): a counter
 * is a word of the buffer bound to its binding's ATOMIC_COUNTER_BUFFER point,
 * at its offset or the one past the counter before it; increment, decrement
 * and read are WGSL atomics there; the program lists its counters and their
 * buffers as 4.2 says, and the buffer's words are read back from the device.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { computeRig } from './compute-fixture.js';
import { GLSL_COUNTER_BINDING } from './glsl-wgsl.js';
import { COUNTER_LIMITS } from './glsl-storage.js';

const CS = `#version 430
layout(local_size_x = 4) in;
layout(binding = 0, offset = 4) uniform atomic_uint hits;
layout(binding = 0) uniform atomic_uint more[2];
void main() {
    uint n = atomicCounterIncrement(hits);
    atomicCounterDecrement(more[1]);
    n += atomicCounter(more[0]);
}`;

test('a counter is its word of the buffer at its binding, changed atomically', async()=>{
    const r = computeRig();
    const { gl } = r;
    const made = r.program([[GL.COMPUTE_SHADER, CS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    const name = r.buffer(GL.ATOMIC_COUNTER_BUFFER, new Uint8Array(new Uint32Array([0, 5, 6, 7])
        .buffer));
    gl.glBindBufferBase(GL.ATOMIC_COUNTER_BUFFER, 0, name);
    assert.deepEqual(gl.glGetIntegeri_v(GL.ATOMIC_COUNTER_BUFFER_BINDING, 0), [name]);
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    assert.deepEqual(r.divergences, []);
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    assert.ok(dispatched, 'replayed at once: the pass changed the counters');
    const entry = dispatched.groups[0].descriptor.entries.find((/** @type {any} */ e)=>
        e.binding === GLSL_COUNTER_BINDING);
    assert.equal(entry.resource.size, 16);
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>text.includes('computeMain'));
    assert.match(code, /var<storage, read_write> gac0: array<atomic<u32>>/);
    // hits at 4 (word 1), more after it at 8 (words 2 and 3).
    assert.match(code, /atomicAdd\(&gac0\[1u\], 1u\)/);
    assert.match(code, /atomicSub\(&gac0\[3u\], 1u\) - 1u/);
    assert.match(code, /atomicLoad\(&gac0\[2u\]\)/);
    // What the device holds, read back.
    entry.resource.buffer.bytes[4] = 9;
    const read = gl.glGetBufferSubDataARB(GL.ATOMIC_COUNTER_BUFFER, 4, 4);
    assert.ok(read instanceof Promise);
    assert.deepEqual([...await read], [9, 0, 0, 0]);
});

test('the program lists its counters and their buffer', ()=>{
    const r = computeRig();
    const { gl } = r;
    const made = r.program([[GL.COMPUTE_SHADER, CS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.ACTIVE_ATOMIC_COUNTER_BUFFERS), [1]);
    const count = gl.glGetProgramiv(made, GL.ACTIVE_UNIFORMS)[0];
    const names = Array.from({ length: count }, (_, k)=>gl.glGetActiveUniformName(made, k));
    const hits = names.indexOf('hits');
    const more = names.indexOf('more[0]');
    assert.ok(hits >= 0 && more >= 0, names.join(','));
    assert.deepEqual(gl.glGetActiveUniformsiv(made, [hits, more], GL.UNIFORM_TYPE),
        [0x92db, 0x92db]);
    assert.deepEqual(gl.glGetActiveUniformsiv(made, [hits, more], GL.UNIFORM_OFFSET), [4, 8]);
    assert.deepEqual(gl.glGetActiveUniformsiv(made, [more], GL.UNIFORM_ARRAY_STRIDE), [4]);
    assert.deepEqual(gl.glGetActiveUniformsiv(made, [hits],
        GL.UNIFORM_ATOMIC_COUNTER_BUFFER_INDEX), [0]);
    assert.equal(gl.glGetUniformLocation(made, 'hits'), -1, 'a counter has no location');
    assert.deepEqual(gl.glGetActiveAtomicCounterBufferiv(made, 0,
        GL.ATOMIC_COUNTER_BUFFER_BINDING), [0]);
    assert.deepEqual(gl.glGetActiveAtomicCounterBufferiv(made, 0,
        GL.ATOMIC_COUNTER_BUFFER_DATA_SIZE), [16]);
    assert.deepEqual(gl.glGetActiveAtomicCounterBufferiv(made, 0,
        GL.ATOMIC_COUNTER_BUFFER_ACTIVE_ATOMIC_COUNTERS), [2]);
    assert.deepEqual(gl.glGetActiveAtomicCounterBufferiv(made, 0,
        GL.ATOMIC_COUNTER_BUFFER_ACTIVE_ATOMIC_COUNTER_INDICES).sort(), [hits, more].sort());
    assert.deepEqual(gl.glGetActiveAtomicCounterBufferiv(made, 0,
        GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_COMPUTE_SHADER), [1]);
    assert.deepEqual(gl.glGetActiveAtomicCounterBufferiv(made, 0,
        GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_FRAGMENT_SHADER), [0]);
    gl.glGetActiveAtomicCounterBufferiv(made, 1, GL.ATOMIC_COUNTER_BUFFER_BINDING);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'one buffer');
});

test('counters out of their binding or overlapping do not link; the limits answer', ()=>{
    const r = computeRig();
    const { gl } = r;
    const link = (/** @type {string} */ declarations)=>{
        const made = r.program([[GL.COMPUTE_SHADER, `#version 430
layout(local_size_x = 1) in;
${declarations}
void main() { atomicCounterIncrement(a); atomicCounterIncrement(b); }`]]);
        return gl.glGetProgramiv(made, GL.LINK_STATUS)[0];
    };
    assert.equal(link(`layout(binding = 0) uniform atomic_uint a;
layout(binding = 0) uniform atomic_uint b;`), 1, 'b at 4, past a');
    assert.equal(link(`layout(binding = 0, offset = 4) uniform atomic_uint a;
layout(binding = 0, offset = 4) uniform atomic_uint b;`), 0, 'overlapping');
    assert.equal(link(`layout(binding = 1) uniform atomic_uint a;
layout(binding = 0) uniform atomic_uint b;`), 0, 'past the bindings');
    const name = r.buffer(GL.ATOMIC_COUNTER_BUFFER, new Uint8Array(64));
    gl.glBindBufferRange(GL.ATOMIC_COUNTER_BUFFER, 0, name, 2, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an offset off the word');
    gl.glBindBufferBase(GL.ATOMIC_COUNTER_BUFFER, COUNTER_LIMITS.bindings, name);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the points');
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_ATOMIC_COUNTER_BUFFER_BINDINGS), [1]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_COMPUTE_ATOMIC_COUNTERS), [8]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_ATOMIC_COUNTERS), [0]);
});

test('a counter range WebGPU cannot bind is said, and the pass changes nothing', async()=>{
    const r = computeRig();
    const { gl } = r;
    gl.glUseProgram(r.program([[GL.COMPUTE_SHADER, CS]]));
    const name = r.buffer(GL.ATOMIC_COUNTER_BUFFER, new Uint8Array(64));
    gl.glBindBufferRange(GL.ATOMIC_COUNTER_BUFFER, 0, name, 4, 32);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'GL takes a word offset');
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    assert.ok(r.divergences.some(d=>/offset 4, which WebGPU does not bind storage at/.test(d)),
        r.divergences.join('\n'));
    assert.ok(!(gl.glGetBufferSubDataARB(GL.ATOMIC_COUNTER_BUFFER, 0, 4) instanceof Promise),
        'the buffer was not written');
});
