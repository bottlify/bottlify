/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Cube map array textures (OpenGL 4.0, ARB_texture_cube_map_array): a 2D
 * array whose layers are six faces a cube, defined, queried, mipmapped and
 * attached by layer-face, and on the device a 2D array sampled through a
 * cube-array view.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @returns {any} */
function context(){
    const gl = createGlContext({});
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    return gl;
}

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
    gl.attach({ width: 16, height: 16, doubleBuffered: true });
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    return { gpu, renderer, gl, divergences, bytes, swap };
}

/**
 * Every texture view a draw's bind groups bound.
 *
 * @param {any} gpu @returns {any[]}
 */
function boundViews(gpu){
    return gpu.of('setBindGroup').flatMap((/** @type {any} */ call)=>
        (call.group?.entries ?? []).map((/** @type {any} */ entry)=>entry.resource))
        .filter((/** @type {any} */ resource)=>resource?.viewDescriptor !== undefined);
}

/** Twelve layer-faces of 2x2 RGBA8, each texel its layer-face's number. */
function faces(){
    const data = new Uint8Array(2 * 2 * 4 * 12);
    for (let layer = 0; layer < 12; layer++)
    {
        data.fill(layer, layer * 16, layer * 16 + 16);
    }
    return data;
}

test('a cube map array is bound, defined by layer-faces and answers its shape', ()=>{
    const gl = context();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, name);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(TEX.TEXTURE_BINDING_CUBE_MAP_ARRAY), [name]);
    gl.glTexImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 2, 2, 12, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, faces());
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetTexLevelParameteriv(TEX.TEXTURE_CUBE_MAP_ARRAY, 0,
        TEX.TEXTURE_DEPTH), [12]);
    gl.glTexImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 2, 2, 7, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'layer-faces not a multiple of six');
    gl.glTexImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 4, 2, 6, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'faces not square');
    gl.glTexSubImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, 0, 0, 7, 1, 1, 1, GL.RGBA,
        GL.UNSIGNED_BYTE, new Uint8Array([200, 201, 202, 203]));
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glTexImage3D(TEX.PROXY_TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 2, 2, 5, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'the proxy checks the same');

    const [stored] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, stored);
    gl.glTexStorage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 2, TEX.RGBA16F, 4, 4, 18);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual([0, 1].map(level=>gl.glGetTexLevelParameteriv(
        TEX.TEXTURE_CUBE_MAP_ARRAY, level, TEX.TEXTURE_DEPTH)[0]), [18, 18],
    'a level keeps its layer-faces');
    const [bad] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, bad);
    gl.glTexStorage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 1, TEX.RGBA16F, 4, 4, 8);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    const [created] = gl.glCreateTextures(TEX.TEXTURE_CUBE_MAP_ARRAY, 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'glCreateTextures makes one');
    assert.ok(created > 0);
});

test('glGenerateMipmap of a cube map array averages each layer-face alone', ()=>{
    const gl = context();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, name);
    gl.glTexImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 2, 2, 12, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, faces());
    gl.glGenerateMipmap(TEX.TEXTURE_CUBE_MAP_ARRAY);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual([GL.TEXTURE_WIDTH, TEX.TEXTURE_DEPTH].map(p=>gl.glGetTexLevelParameteriv(
        TEX.TEXTURE_CUBE_MAP_ARRAY, 1, p)[0]), [1, 12]);
    const out = gl.glGetTexImage(TEX.TEXTURE_CUBE_MAP_ARRAY, 1, GL.RGBA, GL.UNSIGNED_BYTE).packed;
    assert.deepEqual(Array.from(out.filter((/** @type {number} */ _, /** @type {number} */ k)=>
        k % 4 === 0)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('a layer-face of a cube map array is attached by glFramebufferTextureLayer', ()=>{
    const gl = context();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, name);
    gl.glTexImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 2, 2, 12, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, null);
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.glFramebufferTextureLayer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, name, 0, 9);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    assert.deepEqual(gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER,
        GL.COLOR_ATTACHMENT0, GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER), [9]);
    gl.glFramebufferTextureLayer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, name, 0, -1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    const [flat] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, flat);
    gl.glFramebufferTextureLayer(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, flat, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a 2D texture has no layers');
});

test('on the device a cube map array is a 2D array of its layer-faces, sampled as cubes',
    async()=>{
        const r = rig();
        const { gl } = r;
        const [name] = gl.glGenTextures(1);
        gl.glActiveTextureARB(GL.TEXTURE0);
        gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, name);
        gl.glTexImage3D(TEX.TEXTURE_CUBE_MAP_ARRAY, 0, GL.RGBA8, 2, 2, 12, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, faces());
        gl.glTexParameteri(TEX.TEXTURE_CUBE_MAP_ARRAY, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        const program = gl.glCreateProgram();
        for (const [type, text] of /** @type {[number, string][]} */ ([
            [GL.VERTEX_SHADER, '#version 430\nin vec4 p; void main() { gl_Position = p; }'],
            [GL.FRAGMENT_SHADER, '#version 430\nuniform samplerCubeArray s; out vec4 c;\n'
                + 'void main() { c = texture(s, vec4(1.0, 0.0, 0.0, 1.0)); }']]))
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
        new DataView(r.bytes.buffer).setFloat32(0x100, 0, true);
        gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 0, 0x100);
        gl.glEnableVertexAttribArrayARB(0);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        await r.swap();
        assert.deepEqual(r.renderer.diagnostics().failures, []);
        const surfaces = r.gpu.of('createTexture').filter((/** @type {any} */ t)=>
            t.descriptor.label === `gl-texture:${name}`);
        assert.equal(surfaces.length, 1);
        assert.deepEqual(surfaces[0].descriptor.size, { width: 2, height: 2,
            depthOrArrayLayers: 12 });
        const views = r.gpu.of('createView').map((/** @type {any} */ v)=>v.view)
            .filter((/** @type {any} */ v)=>v.viewDescriptor?.label === `gl-texture:${name}:cubes`);
        assert.equal(views.length, 1);
        assert.equal(views[0].viewDescriptor.dimension, 'cube-array');
        assert.ok(boundViews(r.gpu).includes(views[0]), 'the draw samples the cubes\' view');
    });
