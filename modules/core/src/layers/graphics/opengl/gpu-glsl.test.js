/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL 1.30 to 3.30 programs drawn on a recording device: what a draw binds
 * for a program's uniform blocks (the buffer objects at the ranges bound to
 * the blocks' binding points, OpenGL 3.1 section 2.11.4), the number
 * gl_VertexID counts from (section 2.11.7 of 3.0), and an integer
 * attribute's current value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { GLSL_BLOCK_BINDING } from './glsl-wgsl.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

function rig(){
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
    /** @param {number} at @param {number[]} values */
    const floats = (at, values)=>{
        const view = new DataView(bytes.buffer);
        values.forEach((value, i)=>view.setFloat32(at + i * 4, value, true));
    };
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    return { gpu, renderer, gl, divergences, floats, swap };
}

/**
 * @param {any} gl @param {string} vs @param {string} fs
 * @returns {number} the program, linked and in use
 */
function use(gl, vs, fs){
    const program = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, vs], [GL.FRAGMENT_SHADER, fs]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    gl.glUseProgram(program);
    return program;
}

/** The entries of the bind groups the draws were bound with, by binding. @param {any} gpu */
const boundEntries = gpu=>gpu.of('createBindGroup').flatMap((/** @type {any} */ call)=>
    call.descriptor.entries);

/** The vertex positions of a triangle, three floats each, at 0x1000. */
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

test('a uniform block reads the buffer object at the range its binding point holds', async()=>{
    const r = rig();
    const { gl } = r;
    const program = use(gl, `#version 140
in vec3 position;
uniform Placement { vec4 offset; } placement;
uniform Tint { vec4 colour; };
void main() { gl_Position = vec4(position, 1.0) + placement.offset; }`, `#version 140
out vec4 c;
uniform Tint { vec4 colour; };
void main() { c = colour; }`);
    const placement = gl.glGetUniformBlockIndex(program, 'Placement');
    const tint = gl.glGetUniformBlockIndex(program, 'Tint');
    gl.glUniformBlockBinding(program, placement, 3);
    gl.glUniformBlockBinding(program, tint, 5);
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.UNIFORM_BUFFER, buffer);
    r.floats(0x2000, new Array(128).fill(0.25));
    gl.glBufferDataARB(GL.UNIFORM_BUFFER, 512, 0x2000, GL.STATIC_DRAW);
    gl.glBindBufferRange(GL.UNIFORM_BUFFER, 3, buffer, 256, 16);
    gl.glBindBufferBase(GL.UNIFORM_BUFFER, 5, buffer);

    r.floats(0x1000, TRIANGLE);
    const [vertices] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 36, 0x1000, GL.STATIC_DRAW);
    gl.glVertexAttribPointerARB(gl.glGetAttribLocation(program, 'position'), 3, GL.FLOAT, 0, 12, 0);
    gl.glEnableVertexAttribArrayARB(gl.glGetAttribLocation(program, 'position'));
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);

    const entries = boundEntries(r.gpu);
    /** @param {number} block */
    const of = block=>entries.find((/** @type {any} */ e)=>e.binding
        === GLSL_BLOCK_BINDING + block);
    assert.ok(of(placement) && of(tint), 'both blocks bound');
    assert.match(of(placement).resource.buffer.descriptor.label, /gl-buffer:1/);
    assert.equal(of(placement).resource.offset, 256, 'glBindBufferRange\'s offset');
    assert.equal(of(tint).resource.offset, 0, 'glBindBufferBase from the start');
    assert.equal(of(tint).resource.size, 16, 'the block\'s own size');
    const layout = r.gpu.of('createBindGroupLayout').flatMap((/** @type {any} */ call)=>
        call.descriptor.entries).find((/** @type {any} */ e)=>e.binding
            === GLSL_BLOCK_BINDING + tint);
    assert.equal(layout.buffer.type, 'uniform');
    assert.equal(layout.buffer.hasDynamicOffset, undefined, 'bound where the range is');
});

test('a block whose binding point holds nothing reads zeros, and says so', async()=>{
    const r = rig();
    const { gl } = r;
    use(gl, `#version 140
in vec3 position;
uniform Placement { vec4 offset; };
void main() { gl_Position = vec4(position, 1.0) + offset; }`, `#version 140
out vec4 c; void main() { c = vec4(1.0); }`);
    r.floats(0x1000, TRIANGLE);
    gl.glVertexAttribPointerARB(0, 3, GL.FLOAT, 0, 12, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    await r.swap();
    assert.equal(r.divergences.length, 1);
    assert.match(r.divergences[0], /'Placement' was read with no buffer bound to its binding/);
    const entry = boundEntries(r.gpu).find((/** @type {any} */ e)=>e.binding
        === GLSL_BLOCK_BINDING);
    assert.match(entry.resource.buffer.descriptor.label, /gl-zero-block/);
});

test('gl_VertexID counts from the program\'s first vertex, wherever the arrays were put',
    async()=>{
        const r = rig();
        const { gl } = r;
        use(gl, `#version 130
in vec3 position; flat out int id;
void main() { id = gl_VertexID; gl_Position = vec4(position, 1.0); }`, `#version 130
flat in int id; out vec4 c; void main() { c = vec4(float(id)); }`);
        r.floats(0x1000, [...new Array(15).fill(0), ...TRIANGLE]);
        gl.glVertexAttribPointerARB(0, 3, GL.FLOAT, 0, 12, 0x1000);
        gl.glEnableVertexAttribArrayARB(0);
        // Client arrays from vertex 5: the device draws them from its own 0.
        gl.glDrawArrays(GL.TRIANGLES, 5, 3);
        await r.swap();
        assert.deepEqual(r.renderer.diagnostics().failures, []);
        const draw = r.gpu.of('draw')[0];
        const module = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>
            m.descriptor.code).find((/** @type {string} */ code)=>code.includes('vertexIndex'));
        assert.match(module, /vgl_VertexID = i32\(vertexIndex\) \+ vu\.id_bias\.x;/);
        const block = r.gpu.of('setBindGroup').flatMap((/** @type {any} */ call)=>call.resolved)
            .find((/** @type {any} */ b)=>b.size === 16 && /uniforms/
                .test(b.buffer.descriptor.label) && b !== undefined);
        assert.ok(block, 'the vertex block');
        const bias = new Int32Array(block.range.buffer, block.range.byteOffset, 4)[0];
        assert.equal(bias + (draw.args[2] ?? 0), 5,
            'the device\'s first vertex plus the bias is 5');
    });
