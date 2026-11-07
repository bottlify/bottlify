/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texture kinds OpenGL 3.1 to 3.3 adds: swizzles (3.3), rectangles
 * (3.1), buffer textures (3.1) and multisample textures (3.2) -- their
 * state, what the processor reads and what the device is given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** A context on the fake device, with guest memory. */
function rig(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
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
    gl.attach({ width: 16, height: 16, doubleBuffered: true, depthBits: 24 });
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    /** @returns {string[]} the code of every shader module made so far */
    const modules = ()=>gpu.of('createShaderModule').map((/** @type {any} */ call)=>
        call.descriptor.code);
    return { gpu, renderer, gl, divergences, bytes, swap, modules };
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

/** @param {any} gl a quad over the viewport, texture coordinates 0 to 1 */
function quad(gl){
    gl.glBegin(GL.QUADS);
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]])
    {
        gl.glTexCoord2f(x, y);
        gl.glVertex2f(x * 2 - 1, y * 2 - 1);
    }
    gl.glEnd();
}

/** @param {any} gl @returns {number} a 1x1 RGBA texture of (10, 20, 30, 40), bound */
function texel(gl){
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.of(10, 20, 30, 40));
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    return name;
}

// --- swizzle (3.3) ---

test('a swizzle is texture state: four sources, set apart or at once, refused elsewhere', ()=>{
    const gl = /** @type {any} */ (createGlContext({}));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    texel(gl);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA),
        [GL.RED, GL.GREEN, GL.BLUE, GL.ALPHA]);
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_G, GL.ZERO);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_G), [GL.ZERO]);
    gl.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA,
        [GL.ALPHA, GL.ONE, GL.RED, GL.RED]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA),
        [GL.ALPHA, GL.ONE, GL.RED, GL.RED]);
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA, GL.RED);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'all four from a scalar form');
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_B, GL.LUMINANCE);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not a source');
    gl.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA, [GL.RED, GL.RED, 7, GL.RED]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA),
        [GL.ALPHA, GL.ONE, GL.RED, GL.RED], 'a refused vector changes nothing');
    const [sampler] = gl.glGenSamplers(1);
    gl.samplerParameter(sampler, GL.TEXTURE_SWIZZLE_R, [GL.GREEN]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a sampler holds no swizzle');
});

test('the processor reads a swizzled texel', ()=>{
    const bytes = new Uint8Array(0x100);
    const gl = /** @type {any} */ (createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    } }));
    gl.attach({ width: 4, height: 4, doubleBuffered: false });
    texel(gl);
    gl.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA,
        [GL.BLUE, GL.ZERO, GL.RED, GL.ONE]);
    gl.glEnable(GL.TEXTURE_2D);
    gl.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE);
    quad(gl);
    const pixel = gl.glReadPixels(1, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual([...pixel], [30, 0, 10, 255]);
});

test('the device reads a swizzled texture through the fixed stage and a GLSL sampler alike',
    async()=>{
        const r = rig();
        const { gl } = r;
        texel(gl);
        gl.glEnable(GL.TEXTURE_2D);
        quad(gl);
        await r.swap();
        const before = r.modules().length;
        gl.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA,
            [GL.BLUE, GL.ZERO, GL.RED, GL.ONE]);
        quad(gl);
        await r.swap();
        const fixed = r.modules().slice(before);
        assert.ok(fixed.some(code=>code.includes(
            'let t0 = vec4<f32>(t0Read.b, f32(0), t0Read.r, f32(1));')),
        'the unit\'s texel remapped, in a pipeline of its own');

        gl.glDisable(GL.TEXTURE_2D);
        use(gl, `#version 130
in vec4 gl_Vertex;
out vec2 uv;
void main() { uv = gl_Vertex.xy; gl_Position = gl_Vertex; }`, `#version 130
uniform sampler2D image;
in vec2 uv;
out vec4 c;
void main() { c = texture(image, uv) + textureLod(image, uv, 0.0); }`);
        const glslBefore = r.modules().length;
        quad(gl);
        await r.swap();
        const glsl = r.modules().slice(glslBefore).join('\n');
        assert.equal(glsl.match(/vec4<f32>\((\w+)\.b, f32\(0\), \1\.r, f32\(1\)\)/g)?.length, 2,
            'each lookup remapped');
        gl.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_SWIZZLE_RGBA,
            [GL.RED, GL.GREEN, GL.BLUE, GL.ALPHA]);
        const plain = r.modules().length;
        quad(gl);
        await r.swap();
        const unswizzled = r.modules().slice(plain).join('\n');
        assert.ok(unswizzled.length > 0, 'the identity is another pipeline');
        assert.doesNotMatch(unswizzled, /f32\(0\), \w+\.r, f32\(1\)/);
        assert.deepEqual(r.divergences, []);
    });
