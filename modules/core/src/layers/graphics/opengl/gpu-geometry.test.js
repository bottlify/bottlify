/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL 1.50 geometry shaders on a recording device (OpenGL 3.2 section
 * 2.12): a program with one draws through compute passes and an indexed
 * indirect draw (`gpu-geometry.js`), reads each primitive's vertices whole
 * and in the order the mode gives them (adjacency included, by
 * GL_ARB_geometry_shader4's table), refuses a mode its input primitive does
 * not take, and answers its program queries and limits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { geometryOrder, stripWithAdjacency } from './gpu-layout.js';
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

/** @param {any} gl @param {[number, string][]} shaders @returns {number} the program */
function program(gl, shaders){
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
}

const VS = `#version 150
in vec4 position; out vec3 tint;
void main() { tint = position.xyz; gl_Position = position; }`;
const GS = `#version 150
layout(triangles) in; layout(triangle_strip, max_vertices = 3) out;
in vec3 tint[]; out vec3 colour;
void main() {
    for (int i = 0; i < 3; i++) {
        colour = tint[i]; gl_Position = gl_in[i].gl_Position; EmitVertex();
    }
}`;
const FS = `#version 150
in vec3 colour; out vec4 c; void main() { c = vec4(colour, 1.0); }`;

test('a draw through a geometry shader runs its passes, then draws their list indirectly',
    async()=>{
        const r = rig();
        const { gl } = r;
        const made = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, GS],
            [GL.FRAGMENT_SHADER, FS]]);
        assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(made));
        gl.glUseProgram(made);
        r.floats(0x1000, [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1]);
        gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
        gl.glEnableVertexAttribArrayARB(0);
        gl.glDrawArrays(GL.TRIANGLE_STRIP, 0, 4);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        await r.swap();
        assert.deepEqual(r.renderer.diagnostics().failures, []);
        assert.deepEqual(r.divergences, []);
        const dispatched = r.gpu.of('dispatchWorkgroups').map((/** @type {any} */ call)=>
            call.pipeline.descriptor.label);
        assert.deepEqual(dispatched, ['gl:vs-geometry', 'gl:gs', 'gl:geometry-scan',
            'gl:geometry-list']);
        const grids = r.gpu.of('dispatchWorkgroups').map((/** @type {any} */ call)=>call.grid[0]);
        // Two triangles of a strip of four: six positions, two invocations.
        assert.deepEqual(grids, [1, 1, 1, 1]);
        assert.equal(r.gpu.of('drawIndexedIndirect').length, 1);
        // No draw of the arrays: the one direct draw is the frame shown.
        assert.equal(r.gpu.of('drawIndexed').length, 0);
        assert.equal(r.gpu.of('draw').length, 1);
        const modules = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>
            m.descriptor.code).join('\n');
        assert.match(modules, /fn vertexCompute/);
        assert.match(modules, /fn geometryMain/);
        assert.match(modules, /var<storage, read> gsVertices: array<vec4u>/);
        // The vertex pass's parameters: six positions, six an instance.
        const uniforms = r.gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
            /gl-scratch-uniforms/.test(call.buffer.descriptor.label));
        assert.ok(uniforms.length > 0, 'the passes\' uniforms written');
    });

test('a mode the geometry shader\'s input does not take is GL_INVALID_OPERATION', ()=>{
    const r = rig();
    const { gl } = r;
    gl.glUseProgram(program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, GS],
        [GL.FRAGMENT_SHADER, FS]]));
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    for (const mode of [GL.POINTS, GL.LINES, GL.LINE_STRIP, GL.TRIANGLES_ADJACENCY])
    {
        gl.glDrawArrays(mode, 0, 6);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, `mode ${mode}`);
    }
    for (const mode of [GL.TRIANGLES, GL.TRIANGLE_STRIP, GL.TRIANGLE_FAN])
    {
        gl.glDrawArrays(mode, 0, 6);
        assert.equal(gl.glGetError(), GL.NO_ERROR, `mode ${mode}`);
    }
});

test('a program with a geometry shader answers its layout; one without, INVALID_OPERATION',
    ()=>{
        const { gl } = rig();
        const made = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, GS],
            [GL.FRAGMENT_SHADER, FS]]);
        assert.deepEqual(gl.glGetProgramiv(made, GL.GEOMETRY_VERTICES_OUT), [3]);
        assert.deepEqual(gl.glGetProgramiv(made, GL.GEOMETRY_INPUT_TYPE), [GL.TRIANGLES]);
        assert.deepEqual(gl.glGetProgramiv(made, GL.GEOMETRY_OUTPUT_TYPE),
            [GL.TRIANGLE_STRIP]);
        const plain = program(gl, [[GL.VERTEX_SHADER, VS], [GL.FRAGMENT_SHADER, `#version 150
in vec3 tint; out vec4 c; void main() { c = vec4(tint, 1.0); }`]]);
        assert.equal(gl.glGetProgramiv(plain, GL.GEOMETRY_INPUT_TYPE), null);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
        assert.deepEqual(gl.glGetIntegerv(GL.MAX_GEOMETRY_OUTPUT_VERTICES), [256]);
        assert.deepEqual(gl.glGetIntegerv(GL.MAX_GEOMETRY_UNIFORM_BLOCKS)?.length, 1);
    });

test('a link with a geometry shader needs its layouts and a vertex shader, and matches its'
    + ' inputs to the vertex shader\'s outputs by name', ()=>{
    const { gl } = rig();
    const noOutput = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, `#version 150
layout(triangles) in; void main() { EmitVertex(); }`]]);
    assert.deepEqual(gl.glGetProgramiv(noOutput, GL.LINK_STATUS), [0]);
    assert.match(gl.glGetProgramInfoLog(noOutput), /no output primitive/);
    assert.match(gl.glGetProgramInfoLog(noOutput), /max_vertices/);
    const alone = program(gl, [[GL.GEOMETRY_SHADER, GS], [GL.FRAGMENT_SHADER, FS]]);
    assert.match(gl.glGetProgramInfoLog(alone), /no vertex shader/);
    const unmatched = program(gl, [[GL.VERTEX_SHADER, `#version 150
in vec4 position; void main() { gl_Position = position; }`], [GL.GEOMETRY_SHADER, GS],
    [GL.FRAGMENT_SHADER, FS]]);
    assert.match(gl.glGetProgramInfoLog(unmatched), /'tint' is not declared in the vertex/);
});

test('the vertices a geometry shader reads a primitive, adjacency by its table', ()=>{
    // GL_ARB_geometry_shader4 table 2.X1, numbered from 1 there.
    assert.deepEqual(stripWithAdjacency(6), [0, 1, 2, 5, 4, 3]);
    assert.deepEqual(stripWithAdjacency(7), [0, 1, 2, 5, 4, 3], 'an odd last vertex passed over');
    assert.deepEqual(stripWithAdjacency(10), [
        0, 1, 2, 6, 4, 3, // first
        4, 0, 2, 5, 6, 8, // i = 1, odd
        4, 2, 6, 9, 8, 7, // last, even
    ]);
    assert.deepEqual([...geometryOrder(GL.LINE_STRIP_ADJACENCY, 5) ?? []],
        [0, 1, 2, 3, 1, 2, 3, 4]);
    assert.deepEqual([...geometryOrder(GL.TRIANGLE_STRIP, 4) ?? []], [0, 1, 2, 2, 1, 3]);
    assert.equal(geometryOrder(GL.TRIANGLES_ADJACENCY, 12), null);
});
