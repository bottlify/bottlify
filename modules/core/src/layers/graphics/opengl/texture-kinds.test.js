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

// --- rectangles (3.1) ---

/** @param {any} gl @returns {number} a 2x1 rectangle of red then green, bound */
function rectangle(gl){
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_RECTANGLE, name);
    gl.glTexImage2D(GL.TEXTURE_RECTANGLE, 0, GL.RGBA, 2, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255));
    gl.glTexParameteri(GL.TEXTURE_RECTANGLE, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    gl.glTexParameteri(GL.TEXTURE_RECTANGLE, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    return name;
}

test('a rectangle has one level, no mipmap filter, no repeat, and its own binding', ()=>{
    const gl = /** @type {any} */ (createGlContext({}));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    const name = rectangle(gl);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_RECTANGLE), [name]);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [0]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_RECTANGLE_TEXTURE_SIZE), [2048]);
    const [fresh] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_RECTANGLE, fresh);
    assert.deepEqual([GL.TEXTURE_MIN_FILTER, GL.TEXTURE_WRAP_S, GL.TEXTURE_WRAP_T]
        .map(q=>gl.glGetTexParameteriv(GL.TEXTURE_RECTANGLE, q)[0]),
    [GL.LINEAR, GL.CLAMP_TO_EDGE, GL.CLAMP_TO_EDGE], 'its own defaults');
    gl.glTexImage2D(GL.TEXTURE_RECTANGLE, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a level past the first');
    gl.glTexParameteri(GL.TEXTURE_RECTANGLE, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glTexParameteri(GL.TEXTURE_RECTANGLE, GL.TEXTURE_WRAP_S, GL.REPEAT);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glTexParameteri(GL.TEXTURE_RECTANGLE, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_BORDER ?? 0x812d);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'a border clamp is taken');
    gl.glTexParameteri(GL.TEXTURE_RECTANGLE, GL.TEXTURE_BASE_LEVEL, 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    gl.glCompressedTexImage2DARB(GL.TEXTURE_RECTANGLE, 0, 0x83f1, 4, 4, 0, 8, new Uint8Array(8));
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'no compressed rectangle');
    gl.glTexStorage2D(GL.TEXTURE_RECTANGLE, 2, GL.RGBA8, 4, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'one level of storage');
    gl.glTexImage2D(GL.PROXY_TEXTURE_RECTANGLE, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        null);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'its proxy');
    gl.glEnable(GL.TEXTURE_RECTANGLE);
    assert.equal(gl.glIsEnabled(GL.TEXTURE_RECTANGLE), GL.TRUE);
});

test('the fixed stage reads a rectangle at texel coordinates, on the processor and the device',
    async()=>{
        const bytes = new Uint8Array(0x100);
        const gl = /** @type {any} */ (createGlContext({ memory: {
            read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
        } }));
        gl.attach({ width: 4, height: 4, doubleBuffered: false });
        rectangle(gl);
        gl.glEnable(GL.TEXTURE_RECTANGLE);
        gl.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE);
        gl.glBegin(GL.QUADS);
        // Texel coordinates: 0.5 is the middle of the first texel, red; read
        // as a fraction of the width it would be the second's edge.
        for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]])
        {
            gl.glTexCoord2f(0.5, 0.5);
            gl.glVertex2f(x * 2 - 1, y * 2 - 1);
        }
        gl.glEnd();
        assert.deepEqual([...gl.glReadPixels(1, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE)],
            [255, 0, 0, 255]);

        const r = rig();
        rectangle(r.gl);
        r.gl.glEnable(GL.TEXTURE_RECTANGLE);
        quad(r.gl);
        await r.swap();
        assert.ok(r.modules().some(code=>/textureSample\(t0Texture, t0Sampler, input\.tc0\.xy \/ input\.tc0\.w \/ vec2f\(textureDimensions\(t0Texture\)\)\)/
            .test(code)));
        assert.deepEqual(r.divergences, []);
    });

test('a GLSL sampler2DRect reads the unit\'s rectangle binding', async()=>{
    const r = rig();
    const { gl } = r;
    const name = rectangle(gl);
    use(gl, `#version 140
in vec4 position;
void main() { gl_Position = position; }`, `#version 140
uniform sampler2DRect image;
out vec4 c;
void main() { c = texture(image, vec2(1.5, 0.5)) + texelFetch(image, ivec2(0, 0))
    + vec4(textureSize(image), 0, 0); }`);
    gl.glBegin(GL.TRIANGLES);
    gl.glVertex2f(0, 0);
    gl.glVertex2f(1, 0);
    gl.glVertex2f(0, 1);
    gl.glEnd();
    await r.swap();
    const code = r.modules().join('\n');
    assert.match(code, /\/ vec2f\(textureDimensions\(glt0\)\)/);
    const views = r.gpu.of('createBindGroup').flatMap((/** @type {any} */ call)=>
        call.descriptor.entries).filter((/** @type {any} */ e)=>e.binding === 1);
    assert.ok(views.length > 0);
    const labels = r.gpu.of('createTexture').map((/** @type {any} */ c)=>c.descriptor.label);
    assert.ok(labels.includes(`gl-texture:${name}`), 'the rectangle uploaded and bound');
    assert.deepEqual(r.divergences, []);
});

test('a fragment program\'s RECT target samples the unit\'s rectangle', async()=>{
    const r = rig();
    const { gl } = r;
    const name = rectangle(gl);
    const text = '!!ARBfp1.0\nTEX result.color, fragment.texcoord[0], texture[0], RECT;\nEND\n';
    r.bytes.set(new TextEncoder().encode(text), 0x3000);
    gl.glGenProgramsARB(1);
    gl.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 1);
    gl.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB, text.length,
        0x3000);
    gl.glEnable(GL.FRAGMENT_PROGRAM_ARB);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    quad(gl);
    await r.swap();
    const labels = r.gpu.of('createTexture').map((/** @type {any} */ c)=>c.descriptor.label);
    assert.ok(labels.includes(`gl-texture:${name}`), 'the rectangle bound, not a 2D texture');
    assert.deepEqual(r.divergences, []);
});

// --- buffer textures (3.1) ---

test('a buffer texture is a buffer\'s range in a format, with no sampling state', ()=>{
    const gl = /** @type {any} */ (createGlContext({}));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.TEXTURE_BUFFER, buffer);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BUFFER), [buffer], 'a buffer target too');
    gl.glBufferDataARB(GL.TEXTURE_BUFFER, 64, new Uint8Array(64), GL.STATIC_DRAW);
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_BUFFER, name);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_BUFFER), [name]);
    gl.glTexBuffer(GL.TEXTURE_BUFFER, 0x8814 /* RGBA32F */, buffer);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    /** @param {number} q */
    const level = q=>gl.glGetTexLevelParameteriv(GL.TEXTURE_BUFFER, 0, q)[0];
    assert.equal(level(GL.TEXTURE_BUFFER_DATA_STORE_BINDING), buffer);
    assert.equal(level(GL.TEXTURE_INTERNAL_FORMAT), 0x8814);
    assert.equal(level(GL.TEXTURE_BUFFER_SIZE), 64, 'to the end');
    assert.equal(level(GL.TEXTURE_WIDTH), 4, 'texels of sixteen bytes');
    gl.glTexBufferRange(GL.TEXTURE_BUFFER, 0x8236 /* R32UI */, buffer, 8, 12);
    assert.deepEqual([level(GL.TEXTURE_BUFFER_OFFSET), level(GL.TEXTURE_BUFFER_SIZE),
        level(GL.TEXTURE_WIDTH)], [8, 12, 3]);
    gl.glTexBufferRange(GL.TEXTURE_BUFFER, 0x8236, buffer, 8, 60);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the store');
    gl.glTexBufferRange(GL.TEXTURE_BUFFER, 0x8236, buffer, 2, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'off the offset alignment');
    gl.glTexBuffer(GL.TEXTURE_BUFFER, GL.RGB8, buffer);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not a buffer texture\'s format');
    gl.glTexBuffer(GL.TEXTURE_2D, 0x8236, buffer);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glTexBuffer(GL.TEXTURE_BUFFER, 0x8236, 99);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no such buffer');
    gl.glTexParameteri(GL.TEXTURE_BUFFER, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'no sampling state');
    gl.glTexBuffer(GL.TEXTURE_BUFFER, 0x8236, 0);
    assert.equal(level(GL.TEXTURE_BUFFER_DATA_STORE_BINDING), 0, 'detached');
    assert.ok(gl.glGetIntegerv(GL.MAX_TEXTURE_BUFFER_SIZE)[0] >= 65536);
});

test('a GLSL samplerBuffer fetches the buffer\'s texels, as they are at the draw', async()=>{
    const r = rig();
    const { gl } = r;
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.TEXTURE_BUFFER, buffer);
    // Three RGB32F texels: twelve bytes each in the buffer.
    gl.glBufferDataARB(GL.TEXTURE_BUFFER, 36,
        new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer), GL.STATIC_DRAW);
    const [name] = gl.glGenTextures(1);
    gl.glActiveTextureARB(GL.TEXTURE0 + 2);
    gl.glBindTexture(GL.TEXTURE_BUFFER, name);
    gl.glTexBuffer(GL.TEXTURE_BUFFER, 0x8815 /* RGB32F */, buffer);
    const program = use(gl, `#version 140
in vec4 position;
void main() { gl_Position = position; }`, `#version 140
uniform samplerBuffer table;
out vec4 c;
void main() { c = texelFetch(table, 1) + vec4(float(textureSize(table))); }`);
    gl.uniform(gl.glGetUniformLocation(program, 'table'), 1, [2], 'i', 1);
    /** @returns {Float32Array[]} every upload of the texture's level so far */
    const uploads = ()=>r.gpu.of('writeTexture').map((/** @type {any} */ call)=>
        new Float32Array(call.bytes.buffer.slice(call.bytes.byteOffset,
            call.bytes.byteOffset + call.bytes.byteLength)));
    const triangle = ()=>{
        gl.glBegin(GL.TRIANGLES);
        gl.glVertex2f(0, 0);
        gl.glVertex2f(1, 0);
        gl.glVertex2f(0, 1);
        gl.glEnd();
    };
    triangle();
    await r.swap();
    const code = r.modules().join('\n');
    assert.match(code, /textureLoad\(glt0, vec2i\(\w+ % 8192, \w+ \/ 8192\), 0\)/);
    assert.match(code, /i32\(\w+\.x \* \w+\.y\)/, 'its size is its texels\'');
    assert.deepEqual([.../** @type {Float32Array} */ (uploads().at(-1))], [1, 2, 3, 1, 4, 5, 6, 1, 7, 8, 9, 1],
        'three texels, each widened by a fourth component of one');

    gl.glBufferSubDataARB(GL.TEXTURE_BUFFER, 12, 4, new Uint8Array(new Float32Array([40]).buffer));
    triangle();
    await r.swap();
    assert.deepEqual([.../** @type {Float32Array} */ (uploads().at(-1))].slice(4, 8), [40, 5, 6, 1],
        'a write to the buffer reaches the texture');
    assert.deepEqual(r.divergences, []);
});
