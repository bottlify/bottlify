/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Subroutines (OpenGL 4.0 section 7.9, GLSL 4.00 section 6.1.2): the link's
 * tables of functions and uniforms, the queries, glUniformSubroutinesuiv and
 * its refusals, the choice lost to glUseProgram, and the module a draw is
 * made with calling the function chosen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

const VS = `#version 400
in vec4 position; out vec4 colour; void main() { colour = position; gl_Position = position; }`;
const FS = `#version 430
in vec4 colour; out vec4 c;
subroutine vec4 Shade(vec4 x);
subroutine float Scale(float x);
subroutine(Shade) vec4 red(vec4 x) { return vec4(x.r, 0.0, 0.0, 1.0); }
layout(index = 5) subroutine(Shade) vec4 blue(vec4 x) { return vec4(0.0, 0.0, x.b, 1.0); }
subroutine(Scale) float halve(float x) { return x * 0.5; }
subroutine(Shade) vec4 unused(vec4 x) { return x; }
subroutine uniform Shade shade;
layout(location = 3) subroutine uniform Scale scale;
subroutine uniform Shade spare;
void main() { c = shade(colour) * scale(2.0); }`;

const FRAGMENT_SUBROUTINE = 0x92ec;
const FRAGMENT_SUBROUTINE_UNIFORM = 0x92f2;

function rig(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    const renderer = createGpuRenderer({ backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }), divergence: ()=>{} });
    const bytes = new Uint8Array(0x10000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const gl = createGlContext({ memory, gpu: renderer });
    gl.attach({ width: 8, height: 8, doubleBuffered: true });
    const program = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, VS], [GL.FRAGMENT_SHADER, FS]])
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
    return { gl, gpu, renderer, program };
}

test('a stage\'s subroutines: indices and locations, explicit ones first, and the queries',
    ()=>{
        const { gl, program } = rig();
        const F = GL.FRAGMENT_SHADER;
        assert.deepEqual(['red', 'blue', 'halve', 'unused'].map(name=>
            gl.glGetSubroutineIndex(program, F, name)), [0, 5, 1, 2]);
        assert.equal(gl.glGetSubroutineIndex(program, F, 'main'), GL.INVALID_INDEX);
        assert.deepEqual(['shade', 'scale', 'spare'].map(name=>
            gl.glGetSubroutineUniformLocation(program, F, name)), [0, 3, -1],
        'an unused subroutine uniform is not active');
        assert.deepEqual([0x8de5, 0x8de6, 0x8e47, 0x8e48, 0x8e49].map(pname=>
            gl.glGetProgramStageiv(program, F, pname)[0]), [4, 2, 4, 7, 6],
        'functions, uniforms, locations to the last, longest names');
        assert.deepEqual(gl.glGetProgramStageiv(program, GL.VERTEX_SHADER, 0x8de5), [0]);
        assert.deepEqual(gl.glGetActiveSubroutineUniformiv(program, F, 0, 0x8e4b), [0, 5, 2],
            'shade takes red, blue and unused');
        assert.deepEqual(gl.glGetActiveSubroutineUniformiv(program, F, 1, 0x8e4a), [1],
            'scale takes halve alone');
        assert.equal(gl.glGetActiveSubroutineUniformName(program, F, 1), 'scale');
        assert.equal(gl.glGetActiveSubroutineName(program, F, 5), 'blue');
        gl.glGetActiveSubroutineName(program, F, 4);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no function has index 4');
        gl.glGetActiveSubroutineUniformiv(program, F, 2, 0x8e4a);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
        gl.glGetProgramStageiv(program, 0x1234, 0x8de5);
        assert.equal(gl.glGetError(), GL.INVALID_ENUM);
        assert.deepEqual(gl.glGetProgramResourceIndex(program, FRAGMENT_SUBROUTINE, 'halve'), 1);
        assert.equal(gl.glGetProgramResourceLocation(program, FRAGMENT_SUBROUTINE_UNIFORM,
            'scale'), 3, 'the interface queries read the same tables');
    });

test('glUniformSubroutinesuiv: every location at once, compatible, lost to glUseProgram',
    ()=>{
        const { gl, program } = rig();
        const F = GL.FRAGMENT_SHADER;
        gl.glUniformSubroutinesuiv(F, [5, 0, 0, 1]);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no program in use');
        gl.glUseProgram(program);
        gl.glUniformSubroutinesuiv(F, [5, 0, 0]);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'one location short');
        gl.glUniformSubroutinesuiv(F, [4, 0, 0, 1]);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no subroutine of index 4');
        gl.glUniformSubroutinesuiv(F, [1, 0, 0, 1]);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'halve is no Shade');
        gl.glUniformSubroutinesuiv(F, [5, 0, 0, 1]);
        assert.equal(gl.glGetError(), GL.NO_ERROR, 'a location no uniform has takes any');
        assert.deepEqual(gl.glGetUniformSubroutineuiv(F, 0), [5]);
        gl.glUseProgram(program);
        assert.deepEqual(gl.glGetUniformSubroutineuiv(F, 0), [0],
            'glUseProgram of the same program loses the choice: the type\'s first again');
        gl.glGetUniformSubroutineuiv(F, 4);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    });

test('a draw\'s module calls the function chosen; a new choice is a new module', async()=>{
    const { gl, gpu, renderer, program } = rig();
    gl.glUseProgram(program);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x100);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    gl.glUniformSubroutinesuiv(GL.FRAGMENT_SHADER, [5, 0, 0, 1]);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    renderer.present(gl);
    await renderer.settled();
    assert.deepEqual(renderer.diagnostics().failures, []);
    const fragments = gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .filter((/** @type {string} */ code)=>code.includes('fn ffragmentMain')
            || code.includes('@fragment'))
        .map((/** @type {string} */ code)=>/fn fmain\(\) \{[\s\S]*?\n\}/.exec(code)?.[0] ?? '');
    const calls = fragments.map((/** @type {string} */ body)=>
        /ff\d+_(red|blue|unused)\(/.exec(body)?.[1]);
    assert.ok(calls.includes('red'), 'none chosen: Shade\'s first');
    assert.ok(calls.includes('blue'), 'blue chosen');
});
