/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Draws of what transform feedback captured (OpenGL 4.0 and 4.2
 * glDrawTransformFeedback and its forms) and the 4.5 calls that name a
 * transform feedback object: the count is the device's, written by a pass
 * before the draw from the capture's buffer counter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { CAPTURED_SHAPES, createGpuRenderer } from './gpu.js';
import { expandMode, isList } from './gpu-layout.js';
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
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    return { gpu, renderer, gl, divergences, swap };
}

const VS = `#version 150
in vec4 position; out vec3 normal;
void main() { normal = position.xyz; gl_Position = position; }`;
const FS = `#version 150
in vec3 normal; out vec4 c; void main() { c = vec4(normal, 1.0); }`;

/** @param {any} gl @param {boolean} capturing @returns {number} */
function program(gl, capturing){
    const made = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, VS], [GL.FRAGMENT_SHADER, FS]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [String(text)]);
        gl.glCompileShader(shader);
        gl.glAttachShader(made, shader);
    }
    if (capturing)
    {
        gl.glTransformFeedbackVaryings(made, ['normal'], GL.INTERLEAVED_ATTRIBS);
    }
    gl.glLinkProgram(made);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    return made;
}

/**
 * A capture of `count` vertices drawn as `mode` into a 1024-byte buffer at
 * `offset`, through object `xfb`.
 *
 * @param {any} gl @param {number} xfb @param {number} mode @param {number} count
 * @param {number} [offset] @param {number} [instances]
 * @returns {number} the buffer
 */
function capture(gl, xfb, mode, count, offset = 0, instances = 1){
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, buffer);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 1024, 0, GL.STATIC_DRAW);
    gl.glUseProgram(program(gl, true));
    gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, xfb);
    gl.glBindBufferRange(GL.TRANSFORM_FEEDBACK_BUFFER, 0, buffer, offset, 1024 - offset);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x100);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glBeginTransformFeedback(mode === GL.POINTS ? GL.POINTS : GL.TRIANGLES);
    gl.glDrawArraysInstanced(mode, 0, count, instances);
    gl.glEndTransformFeedback();
    gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, 0);
    return buffer;
}

/**
 * The words of the parameters the last `gl:draw-captured` pass read.
 *
 * @param {any} gpu @returns {number[]}
 */
function capturedParams(gpu){
    const passes = gpu.of('dispatchWorkgroups').filter((/** @type {any} */ call)=>
        call.pipeline.descriptor.label === 'gl:draw-captured');
    assert.ok(passes.length > 0, 'a pass counts the draw');
    const entry = passes[passes.length - 1].group.entries.find((/** @type {any} */ e)=>
        e.binding === 1).resource;
    return Array.from(new Uint32Array(entry.buffer.bytes.slice(entry.offset,
        entry.offset + 48).buffer));
}

test('a draw of a capture counts its vertices on the device and draws them indirectly',
    async()=>{
        const r = rig();
        const { gl } = r;
        const [xfb] = gl.glGenTransformFeedbacks(1);
        const buffer = capture(gl, xfb, GL.TRIANGLES, 6, 16);
        gl.glUseProgram(program(gl, false));
        gl.glVertexAttribPointerARB(0, 3, GL.FLOAT, 0, 12, 16);
        gl.drawTransformFeedback(GL.TRIANGLES, xfb, 0, 2);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        await r.swap();
        assert.deepEqual(r.renderer.diagnostics().failures, []);
        assert.deepEqual(r.divergences, []);
        const labels = r.gpu.of('dispatchWorkgroups').map((/** @type {any} */ call)=>
            call.pipeline.descriptor.label);
        assert.equal(labels[labels.length - 1], 'gl:draw-captured');
        const params = capturedParams(r.gpu);
        // The buffer's counter, 12 bytes a vertex past the range's 16; two
        // instances from vertex 0, not indexed; a triangle list of at most
        // the six vertices the capture's one draw could write.
        assert.deepEqual(params.slice(1, 12), [12, 16, 0, 2, 0, 0, 0, 0, 3, 3, 6]);
        const draws = r.gpu.of('drawIndirect');
        assert.equal(draws.length, 1, 'drawn by the arguments the pass wrote');
        assert.equal(draws[0].buffer, r.gpu.of('dispatchWorkgroups').at(-1).group.entries
            .find((/** @type {any} */ e)=>e.binding === 2).resource.buffer);
        assert.ok(buffer > 0);
    });

test('a strip of a capture is drawn by the order laid out for the most, counted by its shape',
    async()=>{
        const r = rig();
        const { gl } = r;
        const [xfb] = gl.glGenTransformFeedbacks(1);
        capture(gl, xfb, GL.TRIANGLE_STRIP, 5, 0, 2);
        gl.glUseProgram(program(gl, false));
        gl.glVertexAttribPointerARB(0, 3, GL.FLOAT, 0, 12, 0);
        gl.drawTransformFeedback(GL.TRIANGLE_STRIP, xfb, 0, 1);
        await r.swap();
        assert.deepEqual(r.renderer.diagnostics().failures, []);
        // Five vertices of a strip are three triangles: nine captured an instance.
        const params = capturedParams(r.gpu);
        assert.deepEqual(params.slice(4, 12), [1, 0, 0, 1, 2, 1, 3, 18]);
        assert.equal(r.gpu.of('drawIndexedIndirect').length, 1);
    });

test('each mode\'s shape counts what its order draws of any number of vertices', ()=>{
    for (const [mode, [a, b, c]] of CAPTURED_SHAPES)
    {
        for (let n = 0; n <= 24; n++)
        {
            const counted = n > a ? Math.floor((n - a) / b) * c : 0;
            const vpp = mode === GL.POINTS ? 1 : mode === GL.LINES ? 2 : 3;
            const listed = isList(mode) ? Math.floor(n / vpp) * vpp
                : expandMode(mode, n)?.length ?? 0;
            // A line loop's closing line is the one part a longer order puts elsewhere.
            const drawn = mode === GL.LINE_LOOP ? Math.max(0, listed - 2) : listed;
            assert.equal(counted, n < 2 && mode === GL.LINE_LOOP ? 0 : drawn,
                `mode ${mode}, ${n} vertices`);
            if (mode !== GL.LINE_LOOP && !isList(mode))
            {
                const most = expandMode(mode, 24);
                const fewer = expandMode(mode, n);
                assert.deepEqual(Array.from(most ?? []).slice(0, counted),
                    Array.from(fewer ?? []), 'the order of n is the start of the most\'s');
            }
        }
    }
});

test('a draw of a capture refuses what the specification does', ()=>{
    const r = rig();
    const { gl } = r;
    gl.drawTransformFeedback(GL.TRIANGLES, 7, 0, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no such object');
    const [xfb] = gl.glGenTransformFeedbacks(1);
    gl.drawTransformFeedback(GL.TRIANGLES, xfb, 0, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'generated, never bound');
    gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, xfb);
    gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, 0);
    gl.drawTransformFeedback(GL.TRIANGLES, xfb, 0, 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no capture has ended');
    capture(gl, xfb, GL.TRIANGLES, 3);
    gl.drawTransformFeedback(GL.TRIANGLES, xfb, 4, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past MAX_VERTEX_STREAMS');
    gl.drawTransformFeedback(0x55, xfb, 0, 1);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.drawTransformFeedback(GL.TRIANGLES, xfb, 0, -1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'negative instances');
    gl.drawTransformFeedback(GL.TRIANGLES, xfb, 1, 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'stream 1 captured nothing, and draws nothing');
});

test('4.5: objects named, their points given buffers and read', ()=>{
    const r = rig();
    const { gl } = r;
    const [xfb] = gl.glCreateTransformFeedbacks(1);
    assert.equal(gl.glIsTransformFeedback(xfb), GL.TRUE, 'created is an object');
    const [buffer] = gl.glGenBuffersARB(1);
    gl.transformFeedbackBuffer(xfb, 1, buffer, 8, 64);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a name that is no buffer yet');
    gl.glBindBufferARB(GL.ARRAY_BUFFER, buffer);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 256, 0, GL.STATIC_DRAW);
    gl.transformFeedbackBuffer(xfb, 1, buffer, 8, 64);
    gl.transformFeedbackBuffer(xfb, 2, buffer, 0, null);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.transformFeedbackIndexed(xfb, GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, 1,
        false), [buffer]);
    assert.deepEqual([GL.TRANSFORM_FEEDBACK_BUFFER_START, GL.TRANSFORM_FEEDBACK_BUFFER_SIZE]
        .map(pname=>gl.transformFeedbackIndexed(xfb, pname, 1, true)[0]), [8, 64]);
    assert.deepEqual(gl.transformFeedbackIndexed(xfb, GL.TRANSFORM_FEEDBACK_BUFFER_SIZE, 2,
        true), [0], 'a whole buffer');
    assert.deepEqual(gl.glGetIntegeri_v(GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, 1), [0],
        'the default object\'s points are not the named one\'s');
    gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, xfb);
    assert.deepEqual(gl.glGetIntegeri_v(GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, 1), [buffer],
        'bound, its points are the context\'s');
    gl.glBindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
    gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, 0);
    assert.deepEqual(gl.glGetIntegeri_v(GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, 0), [0]);
    assert.deepEqual(gl.transformFeedbackIndexed(xfb, GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, 0,
        false), [buffer], 'a bind while it was bound is its own');
    assert.deepEqual(gl.glGetTransformFeedbackiv(xfb, GL.TRANSFORM_FEEDBACK_ACTIVE), [0]);
    assert.deepEqual(gl.glGetTransformFeedbackiv(0, GL.TRANSFORM_FEEDBACK_PAUSED), [0]);
    gl.glGetTransformFeedbackiv(99, GL.TRANSFORM_FEEDBACK_ACTIVE);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no such object');
    gl.glGetTransformFeedbackiv(xfb, GL.TRANSFORM_FEEDBACK_BUFFER_BINDING);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.transformFeedbackIndexed(xfb, GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, 99, false);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.transformFeedbackIndexed(xfb, GL.TRANSFORM_FEEDBACK_BUFFER_START, 0, false);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a start is a 64-bit answer');
    gl.transformFeedbackBuffer(5, 0, buffer, 0, null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no such object');
});
