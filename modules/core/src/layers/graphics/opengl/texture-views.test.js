/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texture views (OpenGL 4.3 section 8.18): what glTextureView refuses, what
 * a view answers, texels written through either the view or its original
 * read through the other, and on the device a view of the original's
 * surface over the levels and layers the view covers.
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

/**
 * A texture of `target` with immutable storage.
 *
 * @param {any} gl @param {number} target @param {number} levels @param {number} internal
 * @param {number} width @param {number} height @param {number} [depth]
 * @returns {number}
 */
function stored(gl, target, levels, internal, width, height, depth){
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(target, name);
    if (depth === undefined)
    {
        gl.glTexStorage2D(target, levels, internal, width, height);
    }
    else
    {
        gl.glTexStorage3D(target, levels, internal, width, height, depth);
    }
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    return name;
}

/** @param {any} gl @param {number} target @param {number} pname */
const parameter = (gl, target, pname)=>gl.glGetTexParameteriv(target, pname)[0];

test('glTextureView refuses what section 8.18 refuses', ()=>{
    const gl = context();
    const array = stored(gl, TEX.TEXTURE_2D_ARRAY, 3, GL.RGBA8, 8, 8, 12);
    const [view, other] = gl.glGenTextures(2);
    const made = (/** @type {any[]} */ ...args)=>{
        gl.glTextureView(...args);
        return gl.glGetError();
    };
    assert.equal(made(0, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 0, 1), GL.INVALID_VALUE,
        'texture zero');
    assert.equal(made(77, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 0, 1), GL.INVALID_OPERATION,
        'a name never generated');
    gl.glBindTexture(GL.TEXTURE_2D, other);
    assert.equal(made(other, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 0, 1), GL.INVALID_OPERATION,
        'a name bound already');
    assert.equal(made(view, GL.TEXTURE_2D, 99, GL.RGBA8, 0, 1, 0, 1), GL.INVALID_VALUE,
        'an original that is no texture');
    const [mutable] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, mutable);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    assert.equal(made(view, GL.TEXTURE_2D, mutable, GL.RGBA8, 0, 1, 0, 1),
        GL.INVALID_OPERATION, 'storage that is not immutable');
    assert.equal(made(view, GL.TEXTURE_3D, array, GL.RGBA8, 0, 1, 0, 1), GL.INVALID_OPERATION,
        'a target table 8.21 does not give the original\'s');
    assert.equal(made(view, GL.TEXTURE_2D, array, TEX.RGBA16F, 0, 1, 0, 1),
        GL.INVALID_OPERATION, 'a format of another class');
    assert.equal(made(view, GL.TEXTURE_2D, array, GL.RGBA8, 3, 1, 0, 1), GL.INVALID_VALUE,
        'past the last level');
    assert.equal(made(view, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 12, 1), GL.INVALID_VALUE,
        'past the last layer');
    assert.equal(made(view, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 0, 2), GL.INVALID_VALUE,
        'a 2D view of two layers');
    assert.equal(made(view, GL.TEXTURE_CUBE_MAP, array, GL.RGBA8, 0, 1, 0, 5),
        GL.INVALID_VALUE, 'a cube map of five faces');
    assert.equal(made(view, TEX.TEXTURE_CUBE_MAP_ARRAY, array, GL.RGBA8, 0, 1, 0, 9),
        GL.INVALID_VALUE, 'a cube map array of nine layer-faces');
    const wide = stored(gl, TEX.TEXTURE_2D_ARRAY, 1, GL.RGBA8, 8, 4, 6);
    assert.equal(made(view, GL.TEXTURE_CUBE_MAP, wide, GL.RGBA8, 0, 1, 0, 6),
        GL.INVALID_OPERATION, 'cube faces that are not square');
    assert.equal(made(view, GL.TEXTURE_2D, array, TEX.RGBA8UI, 0, 1, 0, 1), GL.NO_ERROR,
        'a format of the same class');
    assert.equal(made(view, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 0, 1), GL.INVALID_OPERATION,
        'a name a view is made of already');
});

test('a view answers its range, counted from its original\'s, and the original\'s levels',
    ()=>{
        const gl = context();
        const array = stored(gl, TEX.TEXTURE_2D_ARRAY, 4, GL.RGBA8, 16, 16, 12);
        const [cubes, cube] = gl.glGenTextures(2);
        gl.glTextureView(cubes, TEX.TEXTURE_CUBE_MAP_ARRAY, array, GL.RGBA8, 1, 9, 0, 12);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        gl.glBindTexture(TEX.TEXTURE_CUBE_MAP_ARRAY, cubes);
        assert.deepEqual([TEX.TEXTURE_VIEW_MIN_LEVEL, TEX.TEXTURE_VIEW_NUM_LEVELS,
            TEX.TEXTURE_VIEW_MIN_LAYER, TEX.TEXTURE_VIEW_NUM_LAYERS, 0x82df, 0x912f].map(p=>
            parameter(gl, TEX.TEXTURE_CUBE_MAP_ARRAY, p)), [1, 3, 0, 12, 4, 1],
        'levels clamped to the three past the first; IMMUTABLE_LEVELS the original\'s');
        assert.deepEqual(gl.glGetTexLevelParameteriv(TEX.TEXTURE_CUBE_MAP_ARRAY, 0,
            GL.TEXTURE_WIDTH), [8], 'its level 0 is the original\'s level 1');
        gl.glTextureView(cube, GL.TEXTURE_CUBE_MAP, cubes, GL.RGBA8, 1, 1, 6, 6);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        gl.glBindTexture(GL.TEXTURE_CUBE_MAP, cube);
        assert.deepEqual([TEX.TEXTURE_VIEW_MIN_LEVEL, TEX.TEXTURE_VIEW_NUM_LEVELS,
            TEX.TEXTURE_VIEW_MIN_LAYER, TEX.TEXTURE_VIEW_NUM_LAYERS].map(p=>
            parameter(gl, GL.TEXTURE_CUBE_MAP, p)), [2, 1, 6, 6],
        'a view of a view counts from the first original');
        assert.deepEqual(gl.glGetTexLevelParameteriv(0x8515, 0, GL.TEXTURE_WIDTH), [4]);
        gl.glBindTexture(TEX.TEXTURE_2D_ARRAY, array);
        assert.deepEqual([TEX.TEXTURE_VIEW_MIN_LEVEL, TEX.TEXTURE_VIEW_NUM_LEVELS].map(p=>
            parameter(gl, TEX.TEXTURE_2D_ARRAY, p)), [0, 0], 'a texture that is no view');
    });

test('texels written through the original are the view\'s, and the view\'s the original\'s',
    ()=>{
        const gl = context();
        const array = stored(gl, TEX.TEXTURE_2D_ARRAY, 1, GL.RGBA8, 1, 1, 3);
        gl.glTexSubImage3D(TEX.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 3, GL.RGBA,
            GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
        const [layer, integers] = gl.glGenTextures(2);
        gl.glTextureView(layer, GL.TEXTURE_2D, array, GL.RGBA8, 0, 1, 1, 1);
        gl.glBindTexture(GL.TEXTURE_2D, layer);
        assert.deepEqual(Array.from(gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA,
            GL.UNSIGNED_BYTE).packed), [5, 6, 7, 8], 'the view reads the layer it names');
        gl.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array([50, 60, 70, 80]));
        gl.glBindTexture(TEX.TEXTURE_2D_ARRAY, array);
        assert.deepEqual(Array.from(gl.glGetTexImage(TEX.TEXTURE_2D_ARRAY, 0, GL.RGBA,
            GL.UNSIGNED_BYTE).packed), [1, 2, 3, 4, 50, 60, 70, 80, 9, 10, 11, 12],
        'and the original reads what the view wrote');
        gl.glTextureView(integers, TEX.TEXTURE_2D_ARRAY, array, TEX.RGBA8UI, 0, 1, 2, 1);
        gl.glBindTexture(TEX.TEXTURE_2D_ARRAY, integers);
        assert.deepEqual(gl.glGetTexLevelParameteriv(TEX.TEXTURE_2D_ARRAY, 0,
            GL.TEXTURE_INTERNAL_FORMAT), [TEX.RGBA8UI]);
        assert.deepEqual(Array.from(gl.glGetTexImage(TEX.TEXTURE_2D_ARRAY, 0, TEX.RGBA_INTEGER,
            GL.UNSIGNED_BYTE).packed), [9, 10, 11, 12], 'the same bytes, as integers');
        gl.glDeleteTextures([array]);
        assert.deepEqual(Array.from(gl.glGetTexImage(TEX.TEXTURE_2D_ARRAY, 0, TEX.RGBA_INTEGER,
            GL.UNSIGNED_BYTE).packed), [9, 10, 11, 12], 'the original deleted, its storage lives');
    });

test('on the device a view samples its original\'s surface over the range it covers',
    async()=>{
        const gpu = createFakeDevice();
        const backend = createBackend({ device: gpu.device, queue: gpu.queue,
            presentTo: ()=>{} });
        /** @type {string[]} */
        const divergences = [];
        const renderer = createGpuRenderer({ backend,
            createSampler: descriptor=>({ kind: 'sampler', descriptor }),
            divergence: detail=>divergences.push(detail) });
        const bytes = new Uint8Array(0x10000);
        const memory = {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
        };
        /** @type {any} */
        const gl = createGlContext({ memory, gpu: renderer,
            divergence: d=>divergences.push(d) });
        gl.attach({ width: 16, height: 16, doubleBuffered: true });
        const array = stored(gl, TEX.TEXTURE_2D_ARRAY, 3, GL.RGBA8, 8, 8, 12);
        gl.glTexParameteri(TEX.TEXTURE_2D_ARRAY, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        const [view] = gl.glGenTextures(1);
        gl.glTextureView(view, GL.TEXTURE_CUBE_MAP, array, GL.RGBA8, 1, 2, 6, 6);
        gl.glBindTexture(GL.TEXTURE_CUBE_MAP, view);
        const program = gl.glCreateProgram();
        for (const [type, text] of /** @type {[number, string][]} */ ([
            [GL.VERTEX_SHADER, '#version 330\nin vec4 p; void main() { gl_Position = p; }'],
            [GL.FRAGMENT_SHADER, '#version 330\nuniform samplerCube s; out vec4 c;\n'
                + 'void main() { c = texture(s, vec3(1.0, 0.0, 0.0)); }']]))
        {
            const shader = gl.glCreateShader(type);
            gl.glShaderSource(shader, [text]);
            gl.glCompileShader(shader);
            gl.glAttachShader(program, shader);
        }
        gl.glLinkProgram(program);
        gl.glUseProgram(program);
        gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 0, 0x100);
        gl.glEnableVertexAttribArrayARB(0);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        renderer.present(gl);
        await renderer.settled();
        assert.deepEqual(renderer.diagnostics().failures, []);
        assert.deepEqual(divergences, []);
        const surfaces = gpu.of('createTexture').filter((/** @type {any} */ t)=>
            /^gl-texture:/.test(t.descriptor.label));
        assert.deepEqual(surfaces.map((/** @type {any} */ t)=>t.descriptor.label),
            [`gl-texture:${array}`], 'the view has no surface of its own');
        const made = gpu.of('createView').map((/** @type {any} */ v)=>v.view)
            .filter((/** @type {any} */ v)=>v.viewDescriptor?.label === `gl-texture:${view}:view`);
        assert.equal(made.length, 1);
        const { dimension, baseMipLevel, mipLevelCount, baseArrayLayer, arrayLayerCount } =
            made[0].viewDescriptor;
        assert.deepEqual({ dimension, baseMipLevel, mipLevelCount, baseArrayLayer,
            arrayLayerCount }, { dimension: 'cube', baseMipLevel: 1, mipLevelCount: 2,
            baseArrayLayer: 6, arrayLayerCount: 6 });
        assert.equal(made[0].texture, surfaces[0].texture, 'a view of the original\'s surface');
        const bound = gpu.of('setBindGroup').flatMap((/** @type {any} */ call)=>
            (call.group?.entries ?? []).map((/** @type {any} */ entry)=>entry.resource));
        assert.ok(bound.includes(made[0]), 'the draw samples it');

        // A write through a 2D view of one layer goes up into the original's surface.
        const [layer] = gl.glGenTextures(1);
        gl.glTextureView(layer, GL.TEXTURE_2D, array, GL.RGBA8, 2, 1, 7, 1);
        gl.glBindTexture(GL.TEXTURE_2D, layer);
        const before = gpu.of('writeTexture').length;
        gl.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array(16).fill(0x55));
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        renderer.present(gl);
        await renderer.settled();
        const writes = gpu.of('writeTexture').slice(before).filter((/** @type {any} */ w)=>
            w.destination.texture === surfaces[0].texture);
        assert.equal(writes.length, 1, 'the original\'s level, sent once');
        assert.equal(writes[0].destination.mipLevel, 2);
        const layerBytes = 2 * 2 * 4;
        assert.deepEqual(Array.from(writes[0].bytes.subarray(7 * layerBytes, 8 * layerBytes)),
            new Array(16).fill(0x55), 'the layer the view names');
        assert.deepEqual(divergences, []);
    });

test('a view takes its original\'s parameters; one whose bytes differ reads none and says so',
    ()=>{
        /** @type {string[]} */
        const divergences = [];
        /** @type {any} */
        const gl = createGlContext({ divergence: d=>divergences.push(d) });
        gl.attach({ width: 4, height: 4, doubleBuffered: true });
        const flat = stored(gl, GL.TEXTURE_2D, 1, GL.RGB8, 2, 2);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        const [same, integers] = gl.glGenTextures(2);
        gl.glTextureView(same, GL.TEXTURE_2D, flat, GL.RGB8, 0, 1, 0, 1);
        gl.glBindTexture(GL.TEXTURE_2D, same);
        assert.equal(parameter(gl, GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER), GL.NEAREST,
            'the original\'s state made the view\'s');
        assert.deepEqual(divergences, []);
        // RGB8 keeps four bytes a texel here, RGB8UI three.
        gl.glTextureView(integers, GL.TEXTURE_2D, flat, TEX.RGB8UI, 0, 1, 0, 1);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        assert.ok(divergences.some(d=>/reads none of its original/.test(d)),
            divergences.join('\n'));
        // An array of RGB8 keeps RGBA8 bytes, four a texel: no RGB8UI view of three.
        // A loss is said once a context, so this one is another's.
        /** @type {string[]} */
        const again = [];
        /** @type {any} */
        const other = createGlContext({ divergence: d=>again.push(d) });
        other.attach({ width: 4, height: 4, doubleBuffered: true });
        const array = stored(other, TEX.TEXTURE_2D_ARRAY, 1, GL.RGB8, 2, 2, 2);
        const [layers] = other.glGenTextures(1);
        other.glTextureView(layers, TEX.TEXTURE_2D_ARRAY, array, TEX.RGB8UI, 0, 1, 0, 2);
        assert.ok(again.some(d=>/reads none of its original/.test(d)), again.join('\n'));
    });
