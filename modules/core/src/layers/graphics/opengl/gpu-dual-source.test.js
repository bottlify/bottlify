/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Dual-source blending (OpenGL 3.3, GL_ARB_blend_func_extended): the
 * fragment shader's output of index 1 at location 0 is the blend's second
 * source, on a device with WebGPU's dual-source-blending; without one, or
 * with nothing to give a second source, the draw is a loss, said.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { GL_EXTENSIONS } from './extensions.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @param {string[]} features @returns {any} */
function rig(features){
    const gpu = createFakeDevice({ features });
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const losses = [];
    const renderer = createGpuRenderer({ backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: (/** @type {string} */ detail, /** @type {string | undefined} */ kind)=>{
            if (kind === 'loss')
            {
                losses.push(detail);
            }
        } });
    /** @type {any} */
    const gl = createGlContext({ memory: { read: ()=>new Uint8Array(0), write: ()=>{} },
        gpu: renderer });
    gl.attach({ width: 8, height: 8, doubleBuffered: true });
    const [vertices] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 48, new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 0, 0,
        1, 0, 1, 0, 1]).buffer), GL.STATIC_DRAW);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0);
    gl.glEnableVertexAttribArrayARB(0);
    return { gl, gpu, renderer, losses };
}

/** @param {any} gl @returns {number} */
function dualProgram(gl){
    const program = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, `#version 330
in vec4 position; void main() { gl_Position = position; }`], [GL.FRAGMENT_SHADER, `#version 330
layout(location = 0, index = 0) out vec4 colour;
layout(location = 0, index = 1) out vec4 weight;
void main() { colour = vec4(1.0, 0.5, 0.25, 1.0); weight = vec4(0.5); }`]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    return program;
}

test('the second output of location 0 blends by GL_SRC1_*, on a device that has it', async()=>{
    const { gl, gpu, renderer, losses } = rig(['dual-source-blending']);
    const program = dualProgram(gl);
    gl.glUseProgram(program);
    assert.equal(gl.fragData(program, 'weight', 'index'), 1);
    gl.glEnable(GL.BLEND);
    gl.glBlendFuncSeparate(GL.ONE, GL.SRC1_COLOR, GL.ONE, GL.ONE_MINUS_SRC1_ALPHA);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(GL.BLEND_DST_RGB), [GL.SRC1_COLOR]);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    renderer.present(gl);
    await renderer.settled();
    assert.deepEqual(renderer.diagnostics().failures, []);
    assert.deepEqual(losses, []);
    const pipeline = gpu.of('createRenderPipeline').map((/** @type {any} */ call)=>
        call.descriptor).find((/** @type {any} */ d)=>/dual_source_blending/
        .test(d.fragment.module.descriptor.code));
    assert.ok(pipeline, 'the module enables dual_source_blending');
    assert.deepEqual(pipeline.fragment.targets.length, 1);
    assert.equal(pipeline.fragment.targets[0].blend.color.dstFactor, 'src1');
    assert.equal(pipeline.fragment.targets[0].blend.alpha.dstFactor, 'one-minus-src1-alpha');
    const code = pipeline.fragment.module.descriptor.code;
    assert.match(code, /@location\(0\) @blend_src\(0\) c0: vec4f,\n {4}@location\(0\) @blend_src\(1\) c0s: vec4f,/);
    assert.match(code, /out\.c0s = [^;]*fg_weight/);
});

test('without the device\'s dual-source-blending, or without a GLSL program, the draw is a loss',
    async()=>{
        const without = rig([]);
        without.gl.glUseProgram(dualProgram(without.gl));
        without.gl.glEnable(GL.BLEND);
        without.gl.glBlendFunc(GL.SRC1_ALPHA, GL.ZERO);
        without.gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        without.renderer.present(without.gl);
        await without.renderer.settled();
        assert.match(without.losses.join('\n'), /GL_SRC1_\*.*no dual-source-blending/);
        assert.equal(without.renderer.diagnostics().draws, 0, 'nothing drawn of it');

        const fixed = rig(['dual-source-blending']);
        fixed.gl.glEnable(GL.BLEND);
        fixed.gl.glBlendFunc(GL.ONE, GL.ONE_MINUS_SRC1_COLOR);
        fixed.gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        fixed.renderer.present(fixed.gl);
        await fixed.renderer.settled();
        assert.match(fixed.losses.join('\n'), /only a GLSL program/);
    });

test('GL_ARB_blend_func_extended is reported, and a 1.50 shader enabling it names its outputs\''
    + ' index', ()=>{
    const { gl } = rig(['dual-source-blending']);
    assert.deepEqual(GL_EXTENSIONS.GL_ARB_blend_func_extended,
        ['glBindFragDataLocationIndexed', 'glGetFragDataIndex']);
    /** @param {string} pragma @returns {number[]} the shader's compile status */
    const compiled = pragma=>{
        const shader = gl.glCreateShader(GL.FRAGMENT_SHADER);
        gl.glShaderSource(shader, [`#version 150
${pragma}
#extension GL_ARB_explicit_attrib_location : require
layout(location = 0, index = 1) out vec4 weight;
void main() { weight = vec4(1.0); }`]);
        gl.glCompileShader(shader);
        return gl.glGetShaderiv(shader, GL.COMPILE_STATUS);
    };
    assert.deepEqual(compiled('#extension GL_ARB_blend_func_extended : require'), [1]);
    assert.deepEqual(compiled(''), [0], 'index is 3.30\'s without it');
});
