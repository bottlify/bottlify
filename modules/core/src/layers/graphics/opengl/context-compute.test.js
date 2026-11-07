/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compute shaders on a recording device (OpenGL 4.3 chapter 19): a program
 * with a compute stage dispatches a compute pass among the context's draws,
 * directly or from the DISPATCH_INDIRECT_BUFFER, refuses what section 19.1
 * refuses, and answers its limits and its work group's size.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { COMPUTE_LIMITS } from './glsl-link.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

export function computeRig(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: detail=>divergences.push(detail),
    });
    const bytes = new Uint8Array(0x10000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const gl = createGlContext({ memory, gpu: renderer, divergence: d=>divergences.push(d) });
    gl.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    /** @param {[number, string][]} shaders @returns {number} the program */
    const program = shaders=>{
        const made = gl.glCreateProgram();
        for (const [type, text] of shaders)
        {
            const shader = gl.glCreateShader(type);
            assert.notEqual(shader, 0);
            gl.glShaderSource(shader, [text]);
            gl.glCompileShader(shader);
            assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
                gl.glGetShaderInfoLog(shader));
            gl.glAttachShader(made, shader);
        }
        gl.glLinkProgram(made);
        return made;
    };
    /**
     * @param {number} target @param {Uint8Array | null} data
     * @returns {number} a buffer bound to `target`
     */
    const buffer = (target, data)=>{
        const [name] = gl.glGenBuffersARB(1);
        gl.glBindBufferARB(target, name);
        if (data)
        {
            bytes.set(data, 0x8000);
            gl.glBufferDataARB(target, data.length, 0x8000, GL.STATIC_DRAW);
        }
        return name;
    };
    return { gpu, renderer, gl, divergences, swap, program, buffer, bytes };
}

const CS = `#version 430
layout(local_size_x = 8, local_size_y = 2) in;
shared float cache[16];
uniform float scale;
void main() {
    cache[gl_LocalInvocationIndex] = scale * float(gl_GlobalInvocationID.x);
    barrier();
    memoryBarrierShared();
}`;

test('a dispatch runs the program\'s compute stage in a pass of its own, in its turn', async()=>{
    const r = computeRig();
    const { gl } = r;
    const made = r.program([[GL.COMPUTE_SHADER, CS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    assert.deepEqual(gl.glGetProgramiv(made, GL.COMPUTE_WORK_GROUP_SIZE), [8, 2, 1]);
    gl.glUseProgram(made);
    gl.uniform(gl.glGetUniformLocation(made, 'scale'), 1, [2], 'f', 1);
    gl.glClearColor(1, 0, 0, 1);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    gl.glDispatchCompute(3, 2, 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);
    const dispatched = r.gpu.of('dispatchWorkgroups');
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].grid, [3, 2, 1]);
    assert.equal(dispatched[0].pipeline.descriptor.label, 'gl:compute');
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>text.includes('computeMain'));
    assert.match(code, /@compute @workgroup_size\(8, 2, 1\)/);
    assert.match(code, /var<workgroup> cg_cache: array<f32, 16>/);
    // barrier() and memoryBarrierShared() each.
    assert.equal(code.match(/workgroupBarrier\(\);/g)?.length, 2);
    // The stage's uniforms reach it: 2 in the stage's own block.
    const stage = dispatched[0].groups[0].descriptor.entries
        .find((/** @type {any} */ e)=>e.binding === 20);
    assert.ok(stage, 'the stage\'s uniforms are bound');
    const words = new Float32Array(stage.resource.buffer.bytes.buffer,
        stage.resource.buffer.bytes.byteOffset + stage.resource.offset, 4);
    assert.equal(words[0], 2);
});

test('an indirect dispatch reads its grid from the DISPATCH_INDIRECT_BUFFER', async()=>{
    const r = computeRig();
    const { gl } = r;
    gl.glUseProgram(r.program([[GL.COMPUTE_SHADER, CS]]));
    const grid = new Uint8Array(new Uint32Array([0, 4, 5, 6]).buffer);
    const name = r.buffer(GL.DISPATCH_INDIRECT_BUFFER, grid);
    assert.deepEqual(gl.glGetIntegerv(GL.DISPATCH_INDIRECT_BUFFER_BINDING), [name]);
    gl.glDispatchComputeIndirect(2);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'not a multiple of four');
    gl.glDispatchComputeIndirect(8);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'three words past the end');
    gl.glDispatchComputeIndirect(4);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.divergences, []);
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    assert.equal(dispatched.indirect.offset, 4);
    const words = new Uint32Array(dispatched.indirect.buffer.bytes.buffer,
        dispatched.indirect.buffer.bytes.byteOffset + 4, 3);
    assert.deepEqual([...words], [4, 5, 6], 'the buffer the GPU reads holds the program\'s grid');
    gl.glBindBufferARB(GL.DISPATCH_INDIRECT_BUFFER, 0);
    gl.glDispatchComputeIndirect(0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no buffer bound');
});

test('a dispatch is refused without a compute program, past the limits, and runs nothing empty',
    async()=>{
        const r = computeRig();
        const { gl } = r;
        gl.glDispatchCompute(1, 1, 1);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no program');
        gl.glUseProgram(r.program([[GL.VERTEX_SHADER, '#version 430\nvoid main() {}'],
            [GL.FRAGMENT_SHADER, '#version 430\nvoid main() {}']]));
        gl.glDispatchCompute(1, 1, 1);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a program with no compute stage');
        gl.glUseProgram(r.program([[GL.COMPUTE_SHADER, CS]]));
        gl.glDispatchCompute(COMPUTE_LIMITS.count[0] + 1, 1, 1);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
        gl.glDispatchCompute(0, 4, 4);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        await r.swap();
        assert.equal(r.gpu.of('dispatchWorkgroups').length, 0);
    });

test('a compute program links alone, with a local size within the limits', ()=>{
    const r = computeRig();
    const { gl } = r;
    const mixed = r.program([[GL.COMPUTE_SHADER, CS],
        [GL.VERTEX_SHADER, '#version 430\nvoid main() {}']]);
    assert.deepEqual(gl.glGetProgramiv(mixed, GL.LINK_STATUS), [0]);
    const none = r.program([[GL.COMPUTE_SHADER, '#version 430\nvoid main() {}']]);
    assert.deepEqual(gl.glGetProgramiv(none, GL.LINK_STATUS), [0]);
    const big = r.program([[GL.COMPUTE_SHADER,
        '#version 430\nlayout(local_size_x = 64, local_size_y = 8) in;\nvoid main() {}']]);
    assert.deepEqual(gl.glGetProgramiv(big, GL.LINK_STATUS), [0], 'more invocations than 256');
    gl.glGetProgramiv(none, GL.COMPUTE_WORK_GROUP_SIZE);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not linked');
});

test('the compute limits answer WebGPU\'s, and the GLSL constants agree', ()=>{
    const r = computeRig();
    const { gl } = r;
    for (let axis = 0; axis < 3; axis++)
    {
        assert.deepEqual(gl.glGetIntegeri_v(GL.MAX_COMPUTE_WORK_GROUP_COUNT, axis),
            [COMPUTE_LIMITS.count[axis]]);
        assert.deepEqual(gl.glGetIntegeri_v(GL.MAX_COMPUTE_WORK_GROUP_SIZE, axis),
            [COMPUTE_LIMITS.size[axis]]);
    }
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_COMPUTE_WORK_GROUP_INVOCATIONS), [256]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_COMPUTE_SHARED_MEMORY_SIZE), [16384]);
    assert.ok(gl.glGetIntegerv(GL.MAX_COMPUTE_UNIFORM_BLOCKS)[0] > 0);
    assert.ok(gl.glGetIntegerv(GL.MAX_COMPUTE_TEXTURE_IMAGE_UNITS)[0] > 0);
    // A local size the GLSL constant allows links, one past it does not compile.
    const shader = gl.glCreateShader(GL.COMPUTE_SHADER);
    gl.glShaderSource(shader, ['#version 430\nlayout(local_size_z = 65) in;\nvoid main() {}']);
    gl.glCompileShader(shader);
    assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [0]);
    gl.glShaderSource(shader, ['#version 430\nlayout(local_size_x = 257) in;\nvoid main() {}']);
    gl.glCompileShader(shader);
    assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [0], 'past 256 along x');
});
