/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Image load and store on a recording device (OpenGL 4.2 section 8.26): an
 * image uniform reads and writes the level glBindImageTexture bound to its
 * unit, as a storage texture of its format; the unit is the uniform's value;
 * what WebGPU cannot view so is refused and said, and the units' state
 * answers as 4.2 says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { computeRig } from './compute-fixture.js';
import { GLSL_IMAGE_BINDING } from './glsl-wgsl.js';
import { IMAGE_LIMITS } from './glsl-storage.js';

const RGBA8 = 0x8058;
const R32UI = 0x8236;

const CS = `#version 430
layout(local_size_x = 8, local_size_y = 8) in;
layout(rgba8, binding = 0) uniform readonly image2D src;
layout(rgba8, binding = 1) uniform writeonly image2D dst;
void main() {
    ivec2 p = ivec2(gl_GlobalInvocationID.xy);
    if (any(greaterThanEqual(p, imageSize(dst)))) { return; }
    imageStore(dst, p, imageLoad(src, p).bgra);
}`;

/** @param {any} gl @param {number} internal @returns {number} a 4x4 texture of one level */
const texture = (gl, internal)=>{
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glTexStorage2D(GL.TEXTURE_2D, 2, internal, 4, 4);
    return name;
};

/** @param {any} dispatched @param {number} binding */
const layoutAt = (dispatched, binding)=>dispatched.groups[0].descriptor.layout.descriptor.entries
    .find((/** @type {any} */ e)=>e.binding === binding);

/** @param {any} dispatched @param {number} binding */
const entryAt = (dispatched, binding)=>dispatched.groups[0].descriptor.entries
    .find((/** @type {any} */ e)=>e.binding === binding);

test('an image reads and writes the level its unit binds, as a storage texture', async()=>{
    const r = computeRig();
    const { gl } = r;
    const made = r.program([[GL.COMPUTE_SHADER, CS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    gl.glUseProgram(made);
    const source = texture(gl, GL.RGBA8);
    const target = texture(gl, GL.RGBA8);
    gl.glBindImageTexture(0, source, 0, false, 0, GL.READ_ONLY, RGBA8);
    gl.glBindImageTexture(1, target, 1, false, 0, GL.WRITE_ONLY, RGBA8);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    assert.deepEqual(r.divergences, []);
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    assert.ok(dispatched, 'replayed at once: the pass writes an image');
    assert.deepEqual(layoutAt(dispatched, GLSL_IMAGE_BINDING).storageTexture,
        { access: 'read-only', format: 'rgba8unorm', viewDimension: '2d' });
    assert.deepEqual(layoutAt(dispatched, GLSL_IMAGE_BINDING + 1).storageTexture,
        { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' });
    const written = entryAt(dispatched, GLSL_IMAGE_BINDING + 1).resource;
    assert.equal(written.viewDescriptor.baseMipLevel, 1, 'the level the unit binds');
    assert.equal(written.viewDescriptor.baseArrayLayer, 0);
    assert.ok((written.texture.usage & 0x08) !== 0, 'the texture may be bound as storage');
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>text.includes('computeMain'));
    assert.match(code, /var gim0: texture_storage_2d<rgba8unorm, read>/);
    assert.match(code, /var gim1: texture_storage_2d<rgba8unorm, write>/);
    assert.match(code, /textureStore\(gim1, /);
    assert.match(code, /vec2i\(textureDimensions\(gim1\)\)/);
});

test('an image\'s unit is its uniform\'s value, and a unit WebGPU cannot view is said',
    async()=>{
        const r = computeRig();
        const { gl } = r;
        const made = r.program([[GL.COMPUTE_SHADER, CS]]);
        gl.glUseProgram(made);
        const source = texture(gl, GL.RGBA8);
        const target = texture(gl, GL.RGBA8);
        gl.glBindImageTexture(0, source, 0, false, 0, GL.READ_ONLY, RGBA8);
        gl.glBindImageTexture(5, target, 0, false, 0, GL.READ_WRITE, RGBA8);
        gl.uniform(gl.glGetUniformLocation(made, 'dst'), 1, [5], 'i', 1);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        gl.uniform(gl.glGetUniformLocation(made, 'dst'), 1, [IMAGE_LIMITS.units], 'i', 1);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the units');
        gl.glDispatchCompute(1, 1, 1);
        await r.renderer.settled();
        assert.deepEqual(r.divergences, []);
        const [first] = r.gpu.of('dispatchWorkgroups');
        assert.equal(entryAt(first, GLSL_IMAGE_BINDING + 1).resource.texture.descriptor.label,
            `gl-texture:${target}`);
        assert.notEqual(entryAt(first, GLSL_IMAGE_BINDING + 1).resource.texture,
            entryAt(first, GLSL_IMAGE_BINDING).resource.texture, 'unit 5, not unit 1');
        // A unit naming another format than the shader's: refused, and said.
        gl.glBindImageTexture(5, target, 0, false, 0, GL.WRITE_ONLY, R32UI);
        gl.glDispatchCompute(1, 1, 1);
        await r.renderer.settled();
        assert.ok(r.divergences.some(d=>/image unit 5 binds a texture of rgba8unorm/.test(d)),
            r.divergences.join('\n'));
    });

test('glBindImageTexture checks its arguments, and the units answer', ()=>{
    const r = computeRig();
    const { gl } = r;
    const name = texture(gl, GL.RGBA8);
    gl.glBindImageTexture(IMAGE_LIMITS.units, name, 0, false, 0, GL.READ_ONLY, RGBA8);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the units');
    gl.glBindImageTexture(0, 999, 0, false, 0, GL.READ_ONLY, RGBA8);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no such texture');
    gl.glBindImageTexture(0, name, 0, false, 0, GL.READ_ONLY, GL.RGBA);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'not an image format');
    gl.glBindImageTexture(0, name, 0, false, 0, GL.RGBA, RGBA8);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not an access');
    gl.glBindImageTexture(2, name, 1, true, 3, GL.READ_WRITE, R32UI);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_NAME, 2), [name]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_LEVEL, 2), [1]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_LAYERED, 2), [1]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_LAYER, 2), [3]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_ACCESS, 2), [GL.READ_WRITE]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_FORMAT, 2), [R32UI]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_NAME, 0), [0]);
    gl.glDeleteTextures([name]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.IMAGE_BINDING_NAME, 2), [0], 'deleted');
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_IMAGE_UNITS), [8]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_COMPUTE_IMAGE_UNIFORMS), [4]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_IMAGE_UNIFORMS), [0]);
    // The image uniform's GL type.
    const made = r.program([[GL.COMPUTE_SHADER, CS]]);
    const index = [0, 1].find(k=>gl.glGetActiveUniform(made, k)?.name === 'dst');
    assert.equal(gl.glGetActiveUniform(made, index).type, 0x904d, 'GL_IMAGE_2D');
});

test('an image atomic is refused, and a vertex stage has no images', async()=>{
    const r = computeRig();
    const { gl } = r;
    const vertex = r.program([[GL.VERTEX_SHADER, `#version 430
layout(rgba8) uniform readonly image2D img;
void main() { gl_Position = imageLoad(img, ivec2(0)); }`], [GL.FRAGMENT_SHADER,
        '#version 430\nout vec4 c; void main() { c = vec4(1.0); }']]);
    assert.deepEqual(gl.glGetProgramiv(vertex, GL.LINK_STATUS), [0]);
    gl.glUseProgram(r.program([[GL.COMPUTE_SHADER, `#version 430
layout(local_size_x = 1) in;
layout(r32ui) uniform uimage2D counts;
void main() { imageAtomicAdd(counts, ivec2(0), 1u); }`]]));
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    assert.ok(r.divergences.some(d=>/compute dispatch was refused/.test(d)
        && /imageAtomicAdd/.test(d)), r.divergences.join('\n'));
    assert.equal(r.gpu.of('dispatchWorkgroups').length, 0);
});

test('a sized texture binds as storage of its own format, read and written', async()=>{
    const r = computeRig();
    const { gl } = r;
    gl.glUseProgram(r.program([[GL.COMPUTE_SHADER, `#version 430
layout(local_size_x = 4, local_size_y = 4) in;
layout(r32ui, binding = 3) uniform uimage2D counts;
void main() {
    ivec2 p = ivec2(gl_GlobalInvocationID.xy);
    imageStore(counts, p, imageLoad(counts, p) + uvec4(1u));
}`]]));
    const counts = texture(gl, TEX.R32UI);
    gl.glBindImageTexture(3, counts, 0, false, 0, GL.READ_WRITE, R32UI);
    gl.glDispatchCompute(1, 1, 1);
    await r.renderer.settled();
    assert.deepEqual(r.divergences, []);
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    assert.deepEqual(layoutAt(dispatched, GLSL_IMAGE_BINDING).storageTexture,
        { access: 'read-write', format: 'r32uint', viewDimension: '2d' });
    const view = entryAt(dispatched, GLSL_IMAGE_BINDING).resource;
    assert.equal(view.viewDescriptor.format, 'r32uint');
    assert.ok((view.texture.usage & 0x08) !== 0, 'the texture may be bound as storage');
});
