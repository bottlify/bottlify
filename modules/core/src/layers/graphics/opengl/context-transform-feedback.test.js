/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Transform feedback (OpenGL 3.0 section 2.15, 4.0 section 2.14) on a
 * recording device: what a link captures and where each word goes, the
 * errors of beginning, drawing and binding while capture is active, pause
 * and resume, objects, and the passes a captured draw records.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { compileShader } from './context-glsl.js';
import { linkProgram } from './glsl-link.js';
import { feedbackWrites } from './glsl-wgsl.js';
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
in vec4 position; out vec3 normal; out float weights[2]; out Data { vec2 uv; } data;
void main() { normal = position.xyz; weights[0] = 1.0; weights[1] = 2.0; data.uv = position.xy;
    gl_Position = position; }`;

/**
 * @param {any} gl @param {string[]} names @param {number} mode
 * @returns {number} the program, linked or not
 */
function capturing(gl, names, mode = GL.INTERLEAVED_ATTRIBS){
    const program = gl.glCreateProgram();
    const shader = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glShaderSource(shader, [VS]);
    gl.glCompileShader(shader);
    gl.glAttachShader(program, shader);
    gl.glTransformFeedbackVaryings(program, names, mode);
    gl.glLinkProgram(program);
    return program;
}

test('a link names what it captures; glGetTransformFeedbackVarying lists it, gaps included',
    ()=>{
        const { gl } = rig();
        const program = capturing(gl, ['gl_Position', 'Data.uv', 'gl_SkipComponents2',
            'weights', 'gl_NextBuffer', 'normal']);
        assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(program));
        assert.deepEqual(gl.glGetProgramiv(program, GL.TRANSFORM_FEEDBACK_VARYINGS), [6]);
        assert.deepEqual(gl.glGetProgramiv(program, GL.TRANSFORM_FEEDBACK_BUFFER_MODE),
            [GL.INTERLEAVED_ATTRIBS]);
        assert.deepEqual(gl.glGetProgramiv(program, GL.TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH),
            ['gl_SkipComponents2'.length + 1]);
        assert.deepEqual(gl.glGetTransformFeedbackVarying(program, 1),
            { name: 'Data.uv', size: 1, type: GL.FLOAT_VEC2 });
        assert.deepEqual(gl.glGetTransformFeedbackVarying(program, 2),
            { name: 'gl_SkipComponents2', size: 2, type: 0 });
        assert.deepEqual(gl.glGetTransformFeedbackVarying(program, 3),
            { name: 'weights', size: 2, type: GL.FLOAT });
        assert.equal(gl.glGetTransformFeedbackVarying(program, 6), null);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    });

test('each captured word is a register\'s component, at its buffer\'s word', ()=>{
    const unit = /** @type {any} */ (compileShader([VS], 'vertex').unit);
    const linked = /** @type {any} */ (linkProgram({ vertex: [unit], fragment: [],
        attribBindings: new Map(), feedback: { names: ['gl_Position', 'Data.uv',
            'gl_SkipComponents2', 'weights', 'gl_NextBuffer', 'normal'], mode: 'interleaved' } }));
    assert.ok(linked.ok, linked.log);
    const feedback = linked.program.feedback;
    // 4 + 2 + a gap of 2 + 2 words in buffer 0; normal's 3 in buffer 1.
    assert.deepEqual(feedback.strides, [10, 3]);
    const writes = feedbackWrites(linked.program, 2, true);
    /** @param {number} slot */
    const of = slot=>writes.find(w=>w.slot === slot)?.words.map(w=>
        `${w.register}.${w.component}@${w.word}`);
    assert.deepEqual(of(0), ['0.0@0', '0.1@1', '0.2@2', '0.3@3', '2.0@4', '2.1@5',
        '3.0@8', '4.0@9']);
    assert.deepEqual(of(1), ['5.0@0', '5.1@1', '5.2@2']);
    const separate = /** @type {any} */ (linkProgram({ vertex: [unit], fragment: [],
        attribBindings: new Map(), feedback: { names: ['normal', 'weights[1]'],
            mode: 'separate' } }));
    assert.deepEqual(separate.program.feedback.strides, [3, 1]);
    assert.deepEqual(separate.program.feedback.varyings.map((/** @type {any} */ v)=>
        [v.path, v.buffer, v.word]), [['g_normal', 0, 0], ['g_weights[1]', 1, 0]]);
});

test('a link refuses a name no output has, a name twice, and a gap between separate buffers',
    ()=>{
        const { gl } = rig();
        for (const [names, mode, message] of /** @type {[string[], number, RegExp][]} */ ([
            [['nothing'], GL.INTERLEAVED_ATTRIBS, /'nothing' is not an output/],
            [['normal', 'normal'], GL.INTERLEAVED_ATTRIBS, /named twice/],
            [['weights[2]'], GL.INTERLEAVED_ATTRIBS, /past its array/],
            [['normal', 'gl_NextBuffer'], GL.SEPARATE_ATTRIBS, /separate buffers/],
        ]))
        {
            const program = capturing(gl, names, mode);
            assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [0], names.join());
            assert.match(gl.glGetProgramInfoLog(program), message);
        }
        const program = gl.glCreateProgram();
        gl.glTransformFeedbackVaryings(program, ['a'], GL.FLOAT);
        assert.equal(gl.glGetError(), GL.INVALID_ENUM);
        gl.glTransformFeedbackVaryings(program, ['a', 'b', 'c', 'd', 'e'], GL.SEPARATE_ATTRIBS);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    });

test('begin needs a program that captures and its buffers; while active the program, the'
    + ' buffers and the draw\'s mode stay; paused, they may change', ()=>{
    const { gl } = rig();
    gl.glBeginTransformFeedback(GL.QUADS);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glBeginTransformFeedback(GL.TRIANGLES);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no program');
    const program = capturing(gl, ['normal']);
    gl.glUseProgram(program);
    gl.glBeginTransformFeedback(GL.TRIANGLES);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no buffer bound');
    const [buffer, other] = gl.glGenBuffersARB(2);
    gl.glBindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
    assert.deepEqual(gl.glGetIntegerv(GL.TRANSFORM_FEEDBACK_BUFFER_BINDING), [buffer]);
    gl.glBindBufferRange(GL.TRANSFORM_FEEDBACK_BUFFER, 0, buffer, 4, 6);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a size of words');
    gl.glBeginTransformFeedback(GL.TRIANGLES);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(GL.TRANSFORM_FEEDBACK_ACTIVE), [1]);
    gl.glBeginTransformFeedback(GL.TRIANGLES);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'begun twice');
    gl.glUseProgram(0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'the program in use stays');
    gl.glBindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, other);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'the buffers stay');
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x100);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.POINTS, 0, 3);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'points into triangles');
    gl.glDrawArrays(GL.TRIANGLE_STRIP, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glResumeTransformFeedback();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not paused');
    gl.glPauseTransformFeedback();
    assert.deepEqual(gl.glGetIntegerv(GL.TRANSFORM_FEEDBACK_PAUSED), [1]);
    gl.glDrawArrays(GL.POINTS, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'paused, any mode');
    gl.glResumeTransformFeedback();
    gl.glEndTransformFeedback();
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glEndTransformFeedback();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'ended twice');
});

test('transform feedback objects: bound before they are objects, not switched while capturing',
    ()=>{
        const { gl } = rig();
        const [name] = gl.glGenTransformFeedbacks(1);
        assert.equal(gl.glIsTransformFeedback(name), GL.FALSE, 'not yet bound');
        gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, name);
        assert.equal(gl.glIsTransformFeedback(name), GL.TRUE);
        assert.deepEqual(gl.glGetIntegerv(GL.TRANSFORM_FEEDBACK_BINDING), [name]);
        gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, 77);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a name never made');
        gl.glUseProgram(capturing(gl, ['normal']));
        const [buffer] = gl.glGenBuffersARB(1);
        gl.glBindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
        gl.glBeginTransformFeedback(GL.POINTS);
        gl.glBindTransformFeedback(GL.TRANSFORM_FEEDBACK, 0);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
        gl.glDeleteTransformFeedbacks([name]);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an active object stays');
        gl.glEndTransformFeedback();
        gl.glDeleteTransformFeedbacks([name]);
        assert.deepEqual(gl.glGetIntegerv(GL.TRANSFORM_FEEDBACK_BINDING), [0]);
        assert.equal(gl.glIsTransformFeedback(name), GL.FALSE);
    });

test('a captured draw records its vertex pass and stream output; discarded, it draws nothing',
    async()=>{
        const r = rig();
        const { gl } = r;
        const program = gl.glCreateProgram();
        for (const [type, text] of [[GL.VERTEX_SHADER, VS], [GL.FRAGMENT_SHADER, `#version 150
in vec3 normal; out vec4 c; void main() { c = vec4(normal, 1.0); }`]])
        {
            const shader = gl.glCreateShader(type);
            gl.glShaderSource(shader, [String(text)]);
            gl.glCompileShader(shader);
            gl.glAttachShader(program, shader);
        }
        gl.glTransformFeedbackVaryings(program, ['normal'], GL.INTERLEAVED_ATTRIBS);
        gl.glLinkProgram(program);
        gl.glUseProgram(program);
        const [buffer] = gl.glGenBuffersARB(1);
        gl.glBindBufferARB(GL.TRANSFORM_FEEDBACK_BUFFER, buffer);
        gl.glBufferDataARB(GL.TRANSFORM_FEEDBACK_BUFFER, 64, 0, GL.STATIC_DRAW);
        gl.glBindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
        gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x100);
        gl.glEnableVertexAttribArrayARB(0);
        gl.glEnable(GL.RASTERIZER_DISCARD);
        gl.glBeginTransformFeedback(GL.TRIANGLES);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        gl.glEndTransformFeedback();
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        await r.swap();
        assert.deepEqual(r.renderer.diagnostics().failures, []);
        const labels = r.gpu.of('dispatchWorkgroups').map((/** @type {any} */ call)=>
            call.pipeline.descriptor.label);
        assert.deepEqual(labels, ['gl:feedback-begin', 'gl:vs-geometry', 'gl:stream-out',
            'gl:stream-out-done']);
        assert.equal(r.gpu.of('draw').length, 1, 'only the frame shown');
        const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>
            m.descriptor.code).find((/** @type {string} */ c)=>c.includes('fn streamOut('));
        assert.match(code, /so0\[base \+ 2u\] = vertices\[v \* 3u \+ 2u\]\[2\]/);
        // What was captured is on the device: a read here waits for it.
        const read = gl.glGetBufferSubDataARB(GL.TRANSFORM_FEEDBACK_BUFFER, 0, 4);
        assert.ok(read instanceof Promise);
        assert.equal((await read).length, 4);
        assert.ok(!r.divergences.some(d=>/read a buffer transform feedback wrote/.test(d)));
    });
