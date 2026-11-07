/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texture calls of OpenGL 4.2 to 4.5 that take whole levels or name
 * their images: immutable storage (GL_ARB_texture_storage), copies between
 * images (GL_ARB_copy_image), fills (GL_ARB_clear_texture) and boxes read
 * back (GL_ARB_get_texture_sub_image), on a context that draws on the
 * processor and keeps every level's bytes. Each error case is the one the
 * specification's list names, in its order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { TEXTURE_IMMUTABLE_FORMAT, TEXTURE_IMMUTABLE_LEVELS } from './context-textures.js';
import { TEX } from './formats.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 8, height: 4, doubleBuffered: true });
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    context.glPixelStorei(GL.PACK_ALIGNMENT, 1);
    return context;
}

/** @param {any} gl @param {number} target @returns {number} a new texture bound to target */
function made(gl, target){
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(target, name);
    return name;
}

/** @param {ArrayBufferView} view */
const bytesOf = view=>new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** @param {any} gl @param {number} expected @param {string} [why] */
const error = (gl, expected, why)=>assert.equal(gl.glGetError(), expected, why);

/** A whole level as a box. */
/** @param {number} width @param {number} height @param {number} [depth] */
const all = (width, height, depth = 1)=>({ x: 0, y: 0, z: 0, width, height, depth });

test('glTexStorage2D defines every level at once and makes the texture immutable', ()=>{
    const gl = fixture();
    made(gl, GL.TEXTURE_2D);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, TEXTURE_IMMUTABLE_FORMAT), [0]);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, TEXTURE_IMMUTABLE_LEVELS), [0]);
    gl.glTexStorage2D(GL.TEXTURE_2D, 3, TEX.RGBA16F, 8, 2);
    error(gl, GL.NO_ERROR);
    const shapes = [0, 1, 2, 3].map(level=>[GL.TEXTURE_WIDTH, GL.TEXTURE_HEIGHT,
        GL.TEXTURE_INTERNAL_FORMAT].map(query=>gl.glGetTexLevelParameteriv(GL.TEXTURE_2D, level,
        query)[0]));
    assert.deepEqual(shapes, [[8, 2, TEX.RGBA16F], [4, 1, TEX.RGBA16F], [2, 1, TEX.RGBA16F],
        [0, 0, 1]], 'each level half the one above, height kept at one; no fourth');
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, TEXTURE_IMMUTABLE_FORMAT), [1]);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, TEXTURE_IMMUTABLE_LEVELS), [3]);
    gl.glTexParameteri(GL.TEXTURE_2D, TEXTURE_IMMUTABLE_FORMAT, 0);
    error(gl, GL.INVALID_ENUM, 'immutability is no parameter to set');
    gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 8, 2, 0, GL.RGBA, GL.FLOAT, null);
    error(gl, GL.INVALID_OPERATION, 'an image call on an immutable texture');
    gl.glCopyTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 0, 0, 4, 1, 0);
    error(gl, GL.INVALID_OPERATION, 'a copy into a new level of one');
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 8, 2);
    error(gl, GL.INVALID_OPERATION, 'storage given twice');
    const half = Uint16Array.from([0x3c00, 0x3800, 0, 0x3c00]);
    gl.glTexSubImage2D(GL.TEXTURE_2D, 2, 1, 0, 1, 1, GL.RGBA, TEX.HALF_FLOAT, bytesOf(half));
    error(gl, GL.NO_ERROR, 'its levels take boxes as any level does');
    const back = gl.glGetTextureSubImage(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D)[0], 2,
        all(2, 1), GL.RGBA, TEX.HALF_FLOAT, 64);
    assert.deepEqual(Array.from(new Uint16Array(back.buffer)), [0, 0, 0, 0, ...half]);
});

test('glTexStorage refuses what section 8.19 refuses, in its order', ()=>{
    const gl = fixture();
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 4, 4);
    error(gl, GL.INVALID_OPERATION, 'the default texture');
    made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_3D, 1, GL.RGBA8, 4, 4);
    error(gl, GL.INVALID_ENUM, 'a target of another dimension');
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, GL.RGBA, 4, 4);
    error(gl, GL.INVALID_ENUM, 'an unsized format');
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.COMPRESSED_RED, 4, 4);
    error(gl, GL.INVALID_ENUM, 'a generic compressed format');
    gl.glTexStorage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4);
    error(gl, GL.INVALID_VALUE, 'no levels');
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 4, 0);
    error(gl, GL.INVALID_VALUE, 'no height');
    gl.glTexStorage2D(GL.TEXTURE_2D, 4, GL.RGBA8, 4, 4);
    error(gl, GL.INVALID_OPERATION, 'a level past 1x1');
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 1 << 20, 4);
    error(gl, GL.INVALID_VALUE, 'past the largest texture');
    gl.glTexStorage2D(GL.PROXY_TEXTURE_2D, 1, GL.RGBA8, 1 << 20, 4);
    error(gl, GL.NO_ERROR, 'a proxy answers by what it leaves');
    made(gl, GL.TEXTURE_CUBE_MAP);
    gl.glTexStorage2D(GL.TEXTURE_CUBE_MAP, 1, GL.RGBA8, 4, 2);
    error(gl, GL.INVALID_VALUE, 'a cube map\'s faces are square');
    made(gl, GL.TEXTURE_1D);
    gl.glTexStorage1D(GL.TEXTURE_1D, 1, TEX.COMPRESSED_RED_RGTC1, 4);
    error(gl, GL.INVALID_OPERATION, 'blocks in one dimension');
    made(gl, GL.TEXTURE_3D);
    gl.glTexStorage3D(GL.TEXTURE_3D, 1, TEX.DEPTH_COMPONENT24, 4, 4, 4);
    error(gl, GL.INVALID_OPERATION, 'depth in three');
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_3D, TEXTURE_IMMUTABLE_FORMAT), [0],
        'nothing refused fixed anything');
});

test('glTexStorage shapes: cube faces, arrays\' layers kept, a 3D texture\'s depth halved', ()=>{
    const gl = fixture();
    made(gl, GL.TEXTURE_CUBE_MAP);
    gl.glTexStorage2D(GL.TEXTURE_CUBE_MAP, 2, TEX.R8, 4, 4);
    error(gl, GL.NO_ERROR);
    for (const face of [0x8515, 0x851a])
    {
        assert.deepEqual(gl.glGetTexLevelParameteriv(face, 1, GL.TEXTURE_WIDTH), [2]);
    }
    made(gl, TEX.TEXTURE_2D_ARRAY);
    gl.glTexStorage3D(TEX.TEXTURE_2D_ARRAY, 3, TEX.RG8, 4, 4, 5);
    assert.deepEqual([0, 1, 2].map(level=>gl.glGetTexLevelParameteriv(TEX.TEXTURE_2D_ARRAY,
        level, TEX.TEXTURE_DEPTH)[0]), [5, 5, 5], 'layers kept');
    made(gl, GL.TEXTURE_3D);
    gl.glTexStorage3D(GL.TEXTURE_3D, 3, GL.RGBA8, 4, 4, 8);
    assert.deepEqual([0, 1, 2].map(level=>gl.glGetTexLevelParameteriv(GL.TEXTURE_3D, level,
        TEX.TEXTURE_DEPTH)[0]), [8, 4, 2], 'depth halved');
    made(gl, TEX.TEXTURE_1D_ARRAY);
    gl.glTexStorage2D(TEX.TEXTURE_1D_ARRAY, 3, TEX.R32F, 4, 6);
    assert.deepEqual([0, 1, 2].map(level=>gl.glGetTexLevelParameteriv(TEX.TEXTURE_1D_ARRAY,
        level, GL.TEXTURE_HEIGHT)[0]), [6, 6, 6], 'a 1D array\'s layers are its height');
    made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 3, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 8, 8);
    error(gl, GL.NO_ERROR, 'S3TC blocks');
    gl.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 1, 0, 0, 4, 4,
        GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 16, new Uint8Array(16));
    error(gl, GL.NO_ERROR, 'a level of them takes blocks');
    error(gl, GL.NO_ERROR);
});

test('glCopyImageSubData moves bits, not values, between compatible formats', ()=>{
    const gl = fixture();
    const colour = made(gl, GL.TEXTURE_2D);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 2, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([0, 0, 0x80, 0x3f, 1, 2, 3, 4]));
    const float = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.R32F, 2, 1);
    gl.glCopyImageSubData(colour, GL.TEXTURE_2D, 0, 0, 0, 0, float, GL.TEXTURE_2D, 0, 1, 0, 0,
        1, 1, 1);
    error(gl, GL.NO_ERROR);
    const read = gl.glGetTextureSubImage(float, 0, all(2, 1), GL.RED, GL.FLOAT, 8);
    assert.deepEqual(Array.from(new Float32Array(read.buffer)), [0, 1],
        'RGBA8 bytes 00 00 80 3f are the float 1');
    // A legacy RGB8 level is kept as RGBA bytes; what moves is its three.
    const rgb = made(gl, GL.TEXTURE_2D);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGB8, 1, 1, 0, GL.RGB, GL.UNSIGNED_BYTE,
        Uint8Array.from([7, 8, 9]));
    const integers = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.RGB8UI, 1, 1);
    gl.glCopyImageSubData(rgb, GL.TEXTURE_2D, 0, 0, 0, 0, integers, GL.TEXTURE_2D, 0, 0, 0, 0,
        1, 1, 1);
    error(gl, GL.NO_ERROR, '24 bits a texel both');
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(integers, 0, all(1, 1), TEX.RGB_INTEGER,
        GL.UNSIGNED_BYTE, 3)), [7, 8, 9]);
    gl.glCopyImageSubData(colour, GL.TEXTURE_2D, 0, 0, 0, 0, rgb, GL.TEXTURE_2D, 0, 0, 0, 0,
        1, 1, 1);
    error(gl, GL.INVALID_OPERATION, '32 bits into 24');
});

test('glCopyImageSubData between slices: a cube\'s face, an array\'s layer, a 3D slice', ()=>{
    const gl = fixture();
    const cube = made(gl, GL.TEXTURE_CUBE_MAP);
    gl.glTexStorage2D(GL.TEXTURE_CUBE_MAP, 1, TEX.R8, 2, 2);
    gl.glTexSubImage2D(0x8517, 0, 0, 0, 2, 2, GL.RED, GL.UNSIGNED_BYTE,
        Uint8Array.from([1, 2, 3, 4]));
    const array = made(gl, TEX.TEXTURE_2D_ARRAY);
    gl.glTexStorage3D(TEX.TEXTURE_2D_ARRAY, 1, TEX.R8, 2, 2, 3);
    gl.glCopyImageSubData(cube, GL.TEXTURE_CUBE_MAP, 0, 0, 0, 2, array, TEX.TEXTURE_2D_ARRAY,
        0, 0, 0, 1, 2, 2, 1);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(array, 0, all(2, 2, 3), GL.RED,
        GL.UNSIGNED_BYTE, 12)), [0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0], 'face 2 into layer 1');
    const solid = made(gl, GL.TEXTURE_3D);
    gl.glTexStorage3D(GL.TEXTURE_3D, 1, TEX.R8, 2, 2, 2);
    gl.glCopyImageSubData(array, TEX.TEXTURE_2D_ARRAY, 0, 1, 0, 1, solid, GL.TEXTURE_3D, 0, 0,
        1, 0, 1, 1, 2);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(solid, 0, all(2, 2, 2), GL.RED,
        GL.UNSIGNED_BYTE, 8)), [0, 0, 2, 0, 0, 0, 0, 0], 'two layers into two slices');
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(cube, 0, { x: 0, y: 0, z: 1,
        width: 1, height: 1, depth: 2 }, GL.RED, GL.UNSIGNED_BYTE, 2)), [0, 1],
    'a cube read back by its faces');
});

test('glCopyImageSubData between blocks and texels of the block\'s size', ()=>{
    const gl = fixture();
    const blocks = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const rgtc = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.COMPRESSED_RED_RGTC1, 8, 4);
    gl.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0, 4, 0, 4, 4, TEX.COMPRESSED_RED_RGTC1, 8,
        blocks);
    error(gl, GL.NO_ERROR);
    const wide = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.RG32UI, 2, 1);
    gl.glCopyImageSubData(rgtc, GL.TEXTURE_2D, 0, 4, 0, 0, wide, GL.TEXTURE_2D, 0, 0, 0, 0,
        4, 4, 1);
    error(gl, GL.NO_ERROR, 'one 8-byte block is one 64-bit texel');
    const back = gl.glGetTextureSubImage(wide, 0, all(2, 1), TEX.RG_INTEGER, GL.UNSIGNED_INT, 16);
    assert.deepEqual(Array.from(back.subarray(0, 8)), Array.from(blocks));
    gl.glCopyImageSubData(wide, GL.TEXTURE_2D, 0, 0, 0, 0, rgtc, GL.TEXTURE_2D, 0, 0, 0, 0,
        1, 1, 1);
    error(gl, GL.NO_ERROR, 'and back, one texel a block');
    assert.deepEqual(Array.from(gl.glGetCompressedTextureSubImage(rgtc, 0, all(8, 4), 16)),
        [...blocks, ...blocks]);
    gl.glCopyImageSubData(rgtc, GL.TEXTURE_2D, 0, 2, 0, 0, wide, GL.TEXTURE_2D, 0, 0, 0, 0,
        4, 4, 1);
    error(gl, GL.INVALID_VALUE, 'a box off the blocks');
});

test('glCopyImageSubData refuses what section 18.3.3 refuses', ()=>{
    const gl = fixture();
    const a = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 2, GL.RGBA8, 4, 4);
    const b = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.RG8, 4, 4);
    /** @param {number[]} args @param {number} expected @param {string} why */
    const refused = (args, expected, why)=>{
        gl.glCopyImageSubData(...args);
        error(gl, expected, why);
    };
    refused([a, 0x8515, 0, 0, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 1, 1, 1], GL.INVALID_ENUM,
        'a cube\'s face is no target here');
    refused([a, GL.PROXY_TEXTURE_2D, 0, 0, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 1, 1, 1],
        GL.INVALID_ENUM, 'nor a proxy');
    refused([a, GL.TEXTURE_3D, 0, 0, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 1, 1, 1],
        GL.INVALID_VALUE, 'a name given with another target');
    refused([a, 0x84f5, 0, 0, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 1, 1, 1], GL.INVALID_VALUE,
        'a rectangle texture this name is not');
    refused([a, GL.TEXTURE_2D, 3, 0, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 1, 1, 1],
        GL.INVALID_VALUE, 'a level it does not have');
    refused([a, GL.TEXTURE_2D, 0, 3, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 2, 1, 1],
        GL.INVALID_VALUE, 'past the source\'s edge');
    refused([a, GL.TEXTURE_2D, 0, 0, 0, 1, a, GL.TEXTURE_2D, 1, 0, 0, 0, 1, 1, 1],
        GL.INVALID_VALUE, 'a 2D image has one slice');
    refused([a, GL.TEXTURE_2D, 0, 0, 0, 0, b, GL.TEXTURE_2D, 0, 0, 0, 0, 1, 1, 1],
        GL.INVALID_OPERATION, '32 bits into 16');
    const [rb] = gl.glCreateRenderbuffers(1);
    refused([rb, GL.RENDERBUFFER, 1, 0, 0, 0, a, GL.TEXTURE_2D, 0, 0, 0, 0, 1, 1, 1],
        GL.INVALID_VALUE, 'a renderbuffer has one level');
    refused([a, GL.TEXTURE_2D, 0, 0, 0, 0, a, GL.TEXTURE_2D, 1, 0, 0, 0, 2, 2, 1],
        GL.NO_ERROR, 'one texture\'s levels into each other');
    const loose = made(gl, GL.TEXTURE_2D);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    gl.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    refused([loose, GL.TEXTURE_2D, 1, 0, 0, 0, a, GL.TEXTURE_2D, 0, 0, 0, 0, 1, 1, 1],
        GL.INVALID_OPERATION, 'a level past the base of an incomplete texture');
    refused([loose, GL.TEXTURE_2D, 0, 0, 0, 0, a, GL.TEXTURE_2D, 0, 0, 0, 0, 1, 1, 1],
        GL.NO_ERROR, 'its base level');
});

test('glClearTexImage and glClearTexSubImage fill with one texel, converted', ()=>{
    const gl = fixture();
    const name = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.RG16F, 2, 2);
    gl.clearTexImage('glClearTexImage', name, 0, null, GL.RGBA, GL.FLOAT,
        bytesOf(Float32Array.from([0.5, 2, 9, 9])));
    error(gl, GL.NO_ERROR);
    gl.clearTexImage('glClearTexSubImage', name, 0, { x: 1, y: 1, z: 0, width: 1, height: 1,
        depth: 1 }, GL.RED, GL.FLOAT, null);
    error(gl, GL.NO_ERROR);
    const back = gl.glGetTextureSubImage(name, 0, all(2, 2), TEX.RG, TEX.HALF_FLOAT, 16);
    assert.deepEqual(Array.from(new Uint16Array(back.buffer)),
        [0x3800, 0x4000, 0x3800, 0x4000, 0x3800, 0x4000, 0, 0], 'no data: zeros');
    const legacy = made(gl, GL.TEXTURE_2D);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE, 1, 1, 0, GL.LUMINANCE, GL.UNSIGNED_BYTE,
        Uint8Array.from([0]));
    gl.clearTexImage('glClearTexImage', legacy, 0, null, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([200, 10, 10, 10]));
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(legacy, 0, all(1, 1), GL.RGBA,
        GL.UNSIGNED_BYTE, 4)), [200, 200, 200, 255], 'a luminance level keeps its own');
    /** @param {any[]} args @param {number} expected @param {string} why */
    const refused = (args, expected, why)=>{
        gl.clearTexImage(...args);
        error(gl, expected, why);
    };
    refused(['glClearTexImage', 0, 0, null, GL.RGBA, GL.FLOAT, null], GL.INVALID_OPERATION,
        'no texture');
    refused(['glClearTexImage', name, 1, null, GL.RGBA, GL.FLOAT, null], GL.INVALID_OPERATION,
        'a level with no image');
    refused(['glClearTexImage', name, -1, null, GL.RGBA, GL.FLOAT, null], GL.INVALID_VALUE,
        'a level that cannot be');
    refused(['glClearTexImage', name, 0, null, TEX.RGBA_INTEGER, GL.INT, null],
        GL.INVALID_OPERATION, 'integers for a float format');
    refused(['glClearTexSubImage', name, 0, { x: 1, y: 0, z: 0, width: 2, height: 1,
        depth: 1 }, GL.RGBA, GL.FLOAT, null], GL.INVALID_OPERATION, 'a box past the edge');
    refused(['glClearTexSubImage', name, 0, { x: 0, y: 0, z: 0, width: -1, height: 1,
        depth: 1 }, GL.RGBA, GL.FLOAT, null], GL.INVALID_VALUE, 'a negative box');
    const rgtc = made(gl, GL.TEXTURE_2D);
    gl.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.COMPRESSED_RED_RGTC1, 4, 4);
    refused(['glClearTexImage', rgtc, 0, null, GL.RED, GL.FLOAT, null], GL.INVALID_OPERATION,
        'blocks');
});

test('glGetTextureSubImage reads a box by the pack state, and refuses what 8.11.4 refuses', ()=>{
    const gl = fixture();
    const name = made(gl, GL.TEXTURE_2D);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(name, 0, { x: 1, y: 1, z: 0, width: 1,
        height: 1, depth: 1 }, GL.BGRA, GL.UNSIGNED_BYTE, 4)), [15, 14, 13, 16]);
    gl.glPixelStorei(GL.PACK_SKIP_PIXELS, 1);
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(name, 0, { x: 0, y: 0, z: 0, width: 1,
        height: 1, depth: 1 }, GL.RED, GL.UNSIGNED_BYTE, 2)), [0, 1], 'skipped pixel first');
    gl.glGetTextureSubImage(name, 0, all(1, 1), GL.RED, GL.UNSIGNED_BYTE, 1);
    error(gl, GL.INVALID_OPERATION, 'too small a buffer for the skip');
    gl.glPixelStorei(GL.PACK_SKIP_PIXELS, 0);
    gl.glGetTextureSubImage(name, 0, all(3, 1), GL.RED, GL.UNSIGNED_BYTE, 16);
    error(gl, GL.INVALID_VALUE, 'past the edge');
    gl.glGetTextureSubImage(name, 0, all(1, 1, 2), GL.RED, GL.UNSIGNED_BYTE, 16);
    error(gl, GL.INVALID_VALUE, 'a 2D level has one slice');
    gl.glGetTextureSubImage(99, 0, all(1, 1), GL.RED, GL.UNSIGNED_BYTE, 16);
    error(gl, GL.INVALID_VALUE, 'no such texture');
    gl.glGetTextureSubImage(name, 0, all(1, 1), TEX.RED_INTEGER, GL.UNSIGNED_BYTE, 16);
    error(gl, GL.INVALID_OPERATION, 'integers from a normalised format');
    assert.equal(gl.glGetTextureSubImage(name, 3, all(1, 1), GL.RED, GL.UNSIGNED_BYTE, 16),
        null);
    error(gl, GL.NO_ERROR, 'a level with no image packs nothing');
    gl.glGetCompressedTextureSubImage(name, 0, all(2, 2), 64);
    error(gl, GL.INVALID_OPERATION, 'blocks of an uncompressed level');
});
