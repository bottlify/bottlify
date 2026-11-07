/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL tessellation on a recording device (OpenGL 4.0 section 2.12): a draw of
 * patches runs the vertex shader, the control shader (or the default levels'
 * pass), the tessellator's three passes, then draws the tessellator's indices
 * through the evaluation shader without an index buffer, its arguments on the
 * GPU; what each pass is given follows GL_PATCH_VERTICES and the instances.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { TESS } from './context-tessellation.js';
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

/** @param {any} gl @param {[number, string][]} shaders @returns {number} the program */
function program(gl, shaders){
    const made = gl.glCreateProgram();
    for (const [type, text] of shaders)
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
        gl.glAttachShader(made, shader);
    }
    gl.glLinkProgram(made);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    return made;
}

const VS = `#version 150
in vec4 position; out vec3 vColour;
void main() { vColour = position.xyz; gl_Position = position; }`;
const TCS = `#version 400
layout(vertices = 4) out;
in vec3 vColour[]; out vec3 tColour[]; patch out float scale;
void main() {
    gl_out[gl_InvocationID].gl_Position = gl_in[gl_InvocationID].gl_Position;
    tColour[gl_InvocationID] = vColour[gl_InvocationID];
    barrier();
    gl_TessLevelOuter[0] = 3.0; gl_TessLevelOuter[1] = 3.0;
    gl_TessLevelOuter[2] = 3.0; gl_TessLevelOuter[3] = 3.0;
    gl_TessLevelInner[0] = 2.0; gl_TessLevelInner[1] = 2.0;
    scale = tColour[3].x;
}`;
const TES = `#version 400
layout(quads, fractional_even_spacing, cw) in;
in vec3 tColour[]; patch in float scale; out vec3 colour;
void main() {
    vec4 a = mix(gl_in[0].gl_Position, gl_in[1].gl_Position, gl_TessCoord.x);
    vec4 b = mix(gl_in[3].gl_Position, gl_in[2].gl_Position, gl_TessCoord.x);
    gl_Position = mix(a, b, gl_TessCoord.y) * scale;
    colour = tColour[0];
}`;
const FS = `#version 150
in vec3 colour; out vec4 c; void main() { c = vec4(colour, 1.0); }`;

/** @param {any} r */
const labels = r=>r.gpu.of('dispatchWorkgroups').map((/** @type {any} */ call)=>
    call.pipeline.descriptor.label);

test('a draw of patches runs the tessellation passes, then draws the tessellator\'s indices'
    + ' indirectly', async()=>{
    const r = rig();
    const { gl } = r;
    gl.glUseProgram(program(gl, [[GL.VERTEX_SHADER, VS], [TESS.TESS_CONTROL_SHADER, TCS],
        [TESS.TESS_EVALUATION_SHADER, TES], [GL.FRAGMENT_SHADER, FS]]));
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glPatchParameteri(TESS.PATCH_VERTICES, 4);
    // Ten positions are two patches of four; the last two make none.
    gl.glDrawArraysInstanced(TESS.PATCHES, 0, 10, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);
    assert.deepEqual(labels(r), ['gl:vs-geometry', 'gl:tcs', 'gl:tessellator',
        'gl:tessellator-scan', 'gl:tessellator']);
    const grids = r.gpu.of('dispatchWorkgroups').map((/** @type {any} */ call)=>call.grid);
    // Six patches: a workgroup each for the control shader.
    assert.deepEqual(grids[1].slice(0, 2), [6, 1]);
    const indirect = r.gpu.of('drawIndirect');
    assert.equal(indirect.length, 1, 'the evaluation shader draws, not indexed');
    assert.equal(r.gpu.of('drawIndexedIndirect').length, 0);
    const modules = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>
        m.descriptor.code).join('\n');
    assert.match(modules, /@compute @workgroup_size\(4\)\nfn controlMain/);
    assert.match(modules, /var<workgroup> cg_tColour: array<vec3f, 4>;/);
    assert.match(modules, /workgroupBarrier\(\);/);
    assert.match(modules, /fn vertexMain\(@builtin\(vertex_index\) teVertex: u32\)/);
    // GL's cw is the tessellator's TRIANGLE_CCW (3); fractional even is 3 too.
    assert.match(modules, /tessRecord\(vec4u\(2u, 3u, 3u, 0u\)/);
    const passes = r.renderer.diagnostics();
    assert.ok(passes, 'diagnostics answer');
});

test('without a control shader the default levels make the patches, of GL_PATCH_VERTICES'
    + ' points each', async()=>{
    const r = rig();
    const { gl } = r;
    gl.glUseProgram(program(gl, [[GL.VERTEX_SHADER, VS], [TESS.TESS_EVALUATION_SHADER,
        `#version 400
layout(triangles) in; in vec3 vColour[]; out vec3 colour;
void main() {
    colour = vColour[0];
    gl_Position = gl_TessCoord.x * gl_in[0].gl_Position + gl_TessCoord.y * gl_in[1].gl_Position
        + gl_TessCoord.z * gl_in[2].gl_Position;
}`], [GL.FRAGMENT_SHADER, FS]]));
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glPatchParameteri(TESS.PATCH_VERTICES, 3);
    gl.glPatchParameterfv(TESS.PATCH_DEFAULT_OUTER_LEVEL, [4, 4, 4, 0]);
    gl.glPatchParameterfv(TESS.PATCH_DEFAULT_INNER_LEVEL, [5, 0]);
    gl.glDrawArrays(TESS.PATCHES, 0, 9);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);
    assert.deepEqual(labels(r), ['gl:vs-geometry', 'gl:tess-defaults', 'gl:tessellator',
        'gl:tessellator-scan', 'gl:tessellator']);
    // The defaults pass's parameters: three patches, the triangles' kind, the levels.
    const written = r.gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        /gl-scratch-uniforms/.test(call.buffer.descriptor.label));
    /** @param {Uint8Array} bytes */
    const holdsParams = bytes=>{
        const words = new Uint32Array(bytes.slice(0, bytes.byteLength & ~3).buffer);
        const floats = new Float32Array(words.buffer);
        for (let k = 0; k + 16 <= words.length; k += 4)
        {
            if (words[k] === 3 && words[k + 4] === 1 && words[k + 6] === 2
                && [...floats.subarray(k + 8, k + 14)].join() === '4,4,4,0,5,0')
            {
                return true;
            }
        }
        return false;
    };
    assert.ok(written.some((/** @type {any} */ call)=>holdsParams(call.bytes)),
        'three patches, the triangles\' kind and the default levels reach the pass');
    assert.equal(r.gpu.of('drawIndirect').length, 1);
});

test('fewer positions than a patch draw nothing, and say nothing', async()=>{
    const r = rig();
    const { gl } = r;
    gl.glUseProgram(program(gl, [[GL.VERTEX_SHADER, VS], [TESS.TESS_CONTROL_SHADER, TCS],
        [TESS.TESS_EVALUATION_SHADER, TES], [GL.FRAGMENT_SHADER, FS]]));
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glPatchParameteri(TESS.PATCH_VERTICES, 4);
    gl.glDrawArrays(TESS.PATCHES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(labels(r), []);
    assert.equal(r.gpu.of('drawIndirect').length, 0);
    assert.deepEqual(r.divergences, []);
});
