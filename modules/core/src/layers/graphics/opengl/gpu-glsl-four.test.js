/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL 4.00 to 4.60 on a recording device: the draw parameters (OpenGL 4.6
 * section 11.1.3.9) - gl_BaseVertex the base vertex an indexed draw names,
 * gl_BaseInstance its base instance, gl_DrawID its place in a multi-draw,
 * each in the vertex stage's block - and gl_CullDistance, which culls
 * nothing here and says so (decision A180).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { VERTEX_PROGRAM_BINDING, samplerBinding, samplerIndex } from './arb-wgsl.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

const VS = `#version 460
in vec4 position; out vec4 colour;
void main() { colour = vec4(float(gl_BaseVertex), float(gl_BaseInstance), float(gl_DrawID),
    float(gl_VertexID)); gl_Position = position; }`;
const FS = `#version 460
in vec4 colour; out vec4 c; void main() { c = colour; }`;

/** @param {string} vertex @returns {any} */
function rig(vertex){
    const gpu = createFakeDevice();
    /** @type {string[]} */
    const divergences = [];
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    const renderer = createGpuRenderer({ backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: d=>divergences.push(d) });
    const bytes = new Uint8Array(0x10000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const gl = createGlContext({ memory, gpu: renderer, divergence: d=>divergences.push(d) });
    gl.attach({ width: 8, height: 8, doubleBuffered: true });
    const program = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, FS]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    gl.glUseProgram(program);
    return { gl, gpu, renderer, divergences };
}

test('gl_BaseVertex, gl_BaseInstance and gl_DrawID are what each draw names', async()=>{
    const { gl, gpu, renderer } = rig(VS);
    const [vertices, indices] = gl.glGenBuffersARB(2);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 16 * 16, 0, GL.STATIC_DRAW);
    gl.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, indices);
    gl.glBufferDataARB(GL.ELEMENT_ARRAY_BUFFER, 6, new Uint8Array(new Uint16Array([0, 1, 2])
        .buffer), GL.STATIC_DRAW);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawElementsInstancedBaseVertexBaseInstance(GL.TRIANGLES, 3, GL.UNSIGNED_SHORT, 0, 2, 7,
        3);
    gl.glDrawArrays(GL.TRIANGLES, 5, 3);
    gl.glMultiDrawElementsBaseVertex(GL.TRIANGLES, [3, 3], GL.UNSIGNED_SHORT, [0, 0], 2, [1, 4]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    renderer.present(gl);
    await renderer.settled();
    assert.deepEqual(renderer.diagnostics().failures, []);
    const blocks = gpu.of('setBindGroup').flatMap((/** @type {any} */ call)=>call.resolved
        .filter((/** @type {any} */ r)=>r.binding === VERTEX_PROGRAM_BINDING))
        .map((/** @type {any} */ r)=>Array.from(new Int32Array(r.range.buffer,
            r.range.byteOffset, 4)));
    // The block holds the draw's numbers first: the gl_VertexID bias, then
    // the base vertex, the base instance and the draw's index.
    const draws = blocks.map((/** @type {number[]} */ numbers)=>numbers.slice(1));
    assert.deepEqual(draws, [[7, 3, 0], [0, 0, 0], [1, 0, 0], [4, 0, 1]]);
    const code = gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ c)=>c.includes('fn vertexMain'));
    for (const [name, part] of [['BaseVertex', 'y'], ['BaseInstance', 'z'], ['DrawID', 'w']])
    {
        assert.ok(code.includes(`vgl_${name} = vu.id_bias.${part};`), name);
    }
});

test('a program writing gl_CullDistance draws, and says no primitive is culled by it',
    async()=>{
        const { gl, renderer, divergences } = rig(`#version 450
in vec4 position; out vec4 colour; out float gl_CullDistance[1];
void main() { colour = position; gl_CullDistance[0] = -1.0; gl_Position = position; }`);
        gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x100);
        gl.glEnableVertexAttribArrayARB(0);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        renderer.present(gl);
        await renderer.settled();
        const said = divergences.some((/** @type {string} */ d)=>
            /gl_CullDistance, and no primitive was culled/.test(d));
        assert.ok(said, divergences.join('\n'));
    });

test('sixteen texture units: a program\'s ninth sampler on is bound past the other bindings, '
    + 'each reading its own unit', async()=>{
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    const renderer = createGpuRenderer({ backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }), divergence: ()=>{} });
    /** @type {any} */
    const gl = createGlContext({ memory: { read: ()=>new Uint8Array(0), write: ()=>{} },
        gpu: renderer });
    gl.attach({ width: 8, height: 8, doubleBuffered: true });
    const samplers = Array.from({ length: 12 }, (_, k)=>`uniform sampler2D u${k};`).join(' ');
    const sum = Array.from({ length: 12 }, (_, k)=>`texture(u${k}, vec2(0.5))`).join(' + ');
    const program = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, `#version 400
in vec4 position; void main() { gl_Position = position; }`], [GL.FRAGMENT_SHADER, `#version 400
${samplers} out vec4 c; void main() { c = ${sum}; }`]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    gl.glUseProgram(program);
    const names = gl.glGenTextures(12);
    names.forEach((/** @type {number} */ name, /** @type {number} */ k)=>{
        // Unit 15 - k: the program's samplers read the units backwards.
        gl.glActiveTextureARB(GL.TEXTURE0 + 15 - k);
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            Uint8Array.of(k, 0, 0, 255));
        gl.uniform(gl.glGetUniformLocation(program, `u${k}`), 1, [15 - k], 'i', 1);
    });
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    const [vertices] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 48, new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 0, 0,
        1, 0, 1, 0, 1]).buffer), GL.STATIC_DRAW);
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    renderer.present(gl);
    await renderer.settled();
    assert.deepEqual(renderer.diagnostics().failures, []);
    const code = gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>/glt11/.test(text));
    assert.match(code, /@binding\(15\) var glt7:/);
    assert.match(code, /@binding\(128\) var glt8:/);
    assert.match(code, /@binding\(135\) var gls11:/);
    /** @type {Map<number, string>} each texture binding's view */
    const bound = new Map();
    for (const call of gpu.of('setBindGroup'))
    {
        for (const entry of call.group?.entries ?? [])
        {
            const label = entry.resource?.viewDescriptor?.label;
            if (typeof label === 'string' && label.startsWith('gl-texture:'))
            {
                bound.set(entry.binding, label);
            }
        }
    }
    names.forEach((/** @type {number} */ name, /** @type {number} */ k)=>{
        const binding = k < 8 ? 1 + k * 2 : 128 + (k - 8) * 2;
        assert.match(bound.get(binding) ?? '', new RegExp(`^gl-texture:${name}$`),
            `sampler ${k} reads unit ${15 - k}'s texture`);
    });
    for (let index = 0; index < 16; index++)
    {
        assert.equal(samplerIndex(samplerBinding(index)), index, 'a binding names its sampler');
    }
});

test('a texture wrapped GL_CLAMP_TO_BORDER is sampled clamped to its edge, and that is said',
    async()=>{
        const gpu = createFakeDevice();
        const backend = createBackend({ device: gpu.device, queue: gpu.queue,
            presentTo: ()=>{} });
        /** @type {string[]} */
        const divergences = [];
        /** @type {any[]} */
        const samplers = [];
        const renderer = createGpuRenderer({ backend,
            createSampler: descriptor=>{
                samplers.push(descriptor);
                return { kind: 'sampler', descriptor };
            },
            divergence: d=>divergences.push(d) });
        /** @type {any} */
        const gl = createGlContext({ memory: { read: ()=>new Uint8Array(0), write: ()=>{} },
            gpu: renderer, divergence: d=>divergences.push(d) });
        gl.attach({ width: 8, height: 8, doubleBuffered: true });
        const program = gl.glCreateProgram();
        for (const [type, text] of [[GL.VERTEX_SHADER, `#version 330
in vec4 position; void main() { gl_Position = position; }`], [GL.FRAGMENT_SHADER, `#version 330
uniform sampler2D s; out vec4 c; void main() { c = texture(s, vec2(1.5)); }`]])
        {
            const shader = gl.glCreateShader(type);
            gl.glShaderSource(shader, [text]);
            gl.glCompileShader(shader);
            gl.glAttachShader(program, shader);
        }
        gl.glLinkProgram(program);
        gl.glUseProgram(program);
        const [texture] = gl.glGenTextures(1);
        gl.glBindTexture(GL.TEXTURE_2D, texture);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            Uint8Array.of(1, 2, 3, 4));
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_BORDER);
        const [vertices] = gl.glGenBuffersARB(1);
        gl.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
        gl.glBufferDataARB(GL.ARRAY_BUFFER, 48, new Uint8Array(48), GL.STATIC_DRAW);
        gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0);
        gl.glEnableVertexAttribArrayARB(0);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        renderer.present(gl);
        await renderer.settled();
        assert.match(divergences.join('\n'), /GL_CLAMP_TO_BORDER is clamped to its edge/);
        assert.ok(samplers.some(d=>d.addressModeU === 'clamp-to-edge'));
    });
