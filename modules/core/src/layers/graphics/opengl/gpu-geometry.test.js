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
import { GLSL_GEOMETRY_PASS_BINDING } from './glsl-wgsl.js';
import { UNIFORM } from './wgsl.js';
import { TEX } from './formats.js';

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

test('a geometry shader\'s invocations (4.0) run a primitive that many times, numbered', async()=>{
    const r = rig();
    const { gl } = r;
    const made = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, `#version 400
layout(triangles, invocations = 3) in; layout(triangle_strip, max_vertices = 3) out;
in vec3 tint[]; out vec3 colour;
void main() {
    for (int i = 0; i < 3; i++) {
        colour = tint[i] * float(gl_InvocationID); gl_Position = gl_in[i].gl_Position;
        EmitVertex();
    }
}`], [GL.FRAGMENT_SHADER, FS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    r.floats(0x1000, [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1]);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLE_STRIP, 0, 4);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    const gs = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ code)=>code.includes('fn geometryMain'));
    assert.match(gs, /let primitive = id\.x \/ 3u;/);
    assert.match(gs, /ygl_InvocationID = i32\(id\.x % 3u\);/);
    assert.match(gs, /let in0 = \(primitive \* 3u \+ 0u\)/, 'each invocation reads its primitive');
    // Two triangles, three invocations each: six runs of the shader.
    const pass = r.gpu.of('dispatchWorkgroups').find((/** @type {any} */ call)=>
        call.pipeline.descriptor.label === 'gl:gs');
    const params = pass.groups[1].entries.find((/** @type {any} */ e)=>
        e.binding === GLSL_GEOMETRY_PASS_BINDING.params).resource;
    assert.equal(new Uint32Array(params.buffer.bytes.buffer, params.buffer.bytes.byteOffset
        + params.offset, 1)[0], 6, 'gsParams.invocations');
    assert.equal(gl.glGetIntegerv(GL.MAX_GEOMETRY_SHADER_INVOCATIONS)[0], 32);
});

test('stream 0 is the stream drawn; another one\'s vertices are not, and capturing with them '
    + 'does not link', async()=>{
    const r = rig();
    const { gl } = r;
    const streams = `#version 400
layout(triangles) in; layout(triangle_strip, max_vertices = 6) out;
in vec3 tint[]; out vec3 colour;
void main() {
    for (int i = 0; i < 3; i++) {
        colour = tint[i]; gl_Position = gl_in[i].gl_Position; EmitStreamVertex(0);
    }
    EndStreamPrimitive(0);
    for (int i = 0; i < 3; i++) {
        colour = vec3(1.0); gl_Position = vec4(9.0); EmitStreamVertex(1);
    }
    EndStreamPrimitive(1);
}`;
    const made = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, streams],
        [GL.FRAGMENT_SHADER, FS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    r.floats(0x1000, [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>/fn geometryMain/.test(text));
    // The shader's own main, which the pass's entry point calls.
    const main = code.slice(code.indexOf('fn ymain('), code.indexOf('fn geometryMain'));
    assert.equal(main.match(/emit\(\);/g)?.length, 1, 'stream 0\'s vertex alone is emitted');
    assert.equal(main.match(/cut\(\);/g)?.length, 1);
    assert.doesNotMatch(main, /Stream/);

    const capturing = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, streams],
        [GL.FRAGMENT_SHADER, FS]]);
    gl.glTransformFeedbackVaryings(capturing, ['colour'], GL.INTERLEAVED_ATTRIBS);
    gl.glLinkProgram(capturing);
    assert.deepEqual(gl.glGetProgramiv(capturing, GL.LINK_STATUS), [0]);
    assert.match(gl.glGetProgramInfoLog(capturing), /stream 1 is not supported/);
});

test('a geometry shader\'s gl_ViewportIndex: the draw goes through every viewport, each keeping '
    + 'the primitives sent to it', async()=>{
    const r = rig();
    const { gl } = r;
    const chooser = `#version 410
layout(triangles) in; layout(triangle_strip, max_vertices = 3) out;
in vec3 tint[]; out vec3 colour;
void main() {
    for (int i = 0; i < 3; i++) {
        colour = tint[i]; gl_Position = gl_in[i].gl_Position; gl_ViewportIndex = 3;
        EmitVertex();
    }
}`;
    const reader = `#version 430
in vec3 colour; out vec4 c;
void main() { c = vec4(colour, float(gl_ViewportIndex)); }`;
    const made = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, chooser],
        [GL.FRAGMENT_SHADER, reader]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    gl.glViewportArrayv(3, 1, [8, 4, 16, 8]);
    gl.glDepthRangeArrayv(3, 1, [0.25, 0.5]);
    r.floats(0x1000, [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);
    assert.equal(r.gpu.of('drawIndexedIndirect').length, 16, 'one draw a viewport');
    const rects = r.gpu.of('setViewport').map((/** @type {any} */ call)=>call.rect.join(','));
    assert.ok(rects.includes('0,0,64,32,0,1'), 'the first viewport, the whole window');
    assert.ok(rects.includes('8,20,16,8,0.25,0.5'), `the fourth's rectangle and depths: ${rects}`);
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>/fn vertexMain\(@builtin\(vertex_index\) gsVertex/
            .test(text));
    const cull = new RegExp('if \\(uniforms\\.route\\.x >= 0\\.0 && bitcast<i32>'
        + '\\(gsVertices\\[base \\+ 2u\\]\\.x\\) != i32\\(uniforms\\.route\\.x\\)\\)');
    assert.match(code, cull, 'a vertex of another viewport is put out of the clip volume');
    // The uniform blocks lie in a pool at 256-byte steps: each one's viewport number.
    const numbers = r.gpu.of('writeBuffer').flatMap((/** @type {any} */ call)=>{
        const floats = new Float32Array(call.bytes.buffer, call.bytes.byteOffset,
            call.bytes.byteLength >> 2);
        /** @type {number[]} */
        const found = [];
        for (let at = UNIFORM.route; at < floats.length; at += 64)
        {
            found.push(floats[at]);
        }
        return found;
    });
    for (let index = 0; index < 16; index++)
    {
        assert.ok(numbers.includes(index), `viewport ${index}'s number in its uniforms`);
    }
});

test('a layered framebuffer: gl_Layer draws into the layer chosen, a clear reaches every layer, '
    + 'and without layers gl_Layer is not read', async()=>{
    const r = rig();
    const { gl } = r;
    const [array] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_2D_ARRAY, array);
    gl.glTexImage3D(TEX.TEXTURE_2D_ARRAY, 0, GL.RGBA8, 8, 8, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, 0);
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.glFramebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, array, 0);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER,
        GL.COLOR_ATTACHMENT0, GL.FRAMEBUFFER_ATTACHMENT_LAYERED), [GL.TRUE]);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    const [rb] = gl.glGenRenderbuffers(1);
    gl.bindRenderbuffer(GL.RENDERBUFFER, rb, false);
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.DEPTH_COMPONENT24, 8, 8);
    gl.glFramebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, rb);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER),
        GL.FRAMEBUFFER_INCOMPLETE_LAYER_TARGETS, 'a layered attachment beside one that is not');
    gl.glFramebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, 0);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);

    const chooser = `#version 410
layout(triangles) in; layout(triangle_strip, max_vertices = 3) out;
in vec3 tint[]; out vec3 colour;
void main() {
    for (int i = 0; i < 3; i++) {
        colour = tint[i]; gl_Position = gl_in[i].gl_Position; gl_Layer = 2; gl_ViewportIndex = 0;
        EmitVertex();
    }
}`;
    const reader = `#version 430
in vec3 colour; out vec4 c;
void main() { c = vec4(colour, float(gl_Layer)); }`;
    const made = program(gl, [[GL.VERTEX_SHADER, VS], [GL.GEOMETRY_SHADER, chooser],
        [GL.FRAGMENT_SHADER, reader]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    r.floats(0x1000, [0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    /** @param {number} from @returns {number[]} the array's layers passes drew into */
    const passLayers = from=>[...new Set(r.gpu.of('beginRenderPass').slice(from)
        .flatMap((/** @type {any} */ call)=>call.descriptor.colorAttachments.filter(
            (/** @type {any} */ a)=>a?.view?.viewDescriptor?.label
                ?.startsWith(`gl-texture:${array}:`))
            .map((/** @type {any} */ a)=>a.view.viewDescriptor.baseArrayLayer)))].sort();
    gl.glClear(GL.COLOR_BUFFER_BIT);
    await r.swap();
    assert.deepEqual(passLayers(0), [0, 1, 2, 3], 'a clear reaches every layer');
    const passes = r.gpu.of('beginRenderPass').length;
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);
    assert.deepEqual(passLayers(passes), [0, 1, 2, 3], 'the draw goes into every layer');
    assert.equal(r.gpu.of('drawIndexedIndirect').length, 16 * 4,
        'once a viewport and a layer');
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>/gsVertex/.test(text));
    assert.match(code, /uniforms\.route\.y >= 0\.0 && bitcast<i32>\(gsVertices\[base \+ 3u\]\.x\)/,
        'the layer, after the viewport');
    assert.match(code, /fgl_Layer = input\.i2;/, 'the fragment reads the layer\'s field');
    const routes = r.gpu.of('writeBuffer').flatMap((/** @type {any} */ call)=>{
        const floats = new Float32Array(call.bytes.buffer, call.bytes.byteOffset,
            call.bytes.byteLength >> 2);
        /** @type {string[]} */
        const found = [];
        for (let at = UNIFORM.route; at + 1 < floats.length; at += 64)
        {
            found.push(`${floats[at]},${floats[at + 1]}`);
        }
        return found;
    });
    for (let layer = 0; layer < 4; layer++)
    {
        assert.ok(routes.includes(`5,${layer}`), `viewport 5 into layer ${layer}`);
    }

    // The same program into the window, which has no layers: gl_Layer unread.
    gl.bindFramebuffer(GL.FRAMEBUFFER, 0, false);
    const before = r.gpu.of('drawIndexedIndirect').length;
    const written = r.gpu.of('writeBuffer').length;
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    await r.swap();
    assert.equal(r.gpu.of('drawIndexedIndirect').length - before, 16, 'once a viewport');
    const unrouted = r.gpu.of('writeBuffer').slice(written).flatMap((/** @type {any} */ call)=>{
        const floats = new Float32Array(call.bytes.buffer, call.bytes.byteOffset,
            call.bytes.byteLength >> 2);
        /** @type {number[]} */
        const found = [];
        for (let at = UNIFORM.route + 1; at < floats.length; at += 64)
        {
            found.push(floats[at]);
        }
        return found;
    });
    assert.ok(unrouted.includes(-1), 'no layer to keep to');
});

test('a cube map attached whole is layered: a clear reaches its six faces', async()=>{
    const r = rig();
    const { gl } = r;
    const [cube] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_CUBE_MAP, cube);
    for (let face = 0; face < 6; face++)
    {
        gl.glTexImage2D(0x8515 + face, 0, GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    }
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.glFramebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, cube, 0);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER,
        GL.COLOR_ATTACHMENT0, GL.FRAMEBUFFER_ATTACHMENT_LAYERED), [GL.TRUE]);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    await r.swap();
    assert.deepEqual(r.divergences, []);
    const faces = new Set(r.gpu.of('beginRenderPass').flatMap((/** @type {any} */ call)=>
        call.descriptor.colorAttachments.filter((/** @type {any} */ a)=>
            a?.view?.viewDescriptor?.label?.startsWith(`gl-texture:${cube}:`))
            .map((/** @type {any} */ a)=>a.view.viewDescriptor.baseArrayLayer)));
    assert.deepEqual([...faces].sort(), [0, 1, 2, 3, 4, 5]);
});
