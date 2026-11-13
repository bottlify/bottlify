/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Levels kept in the format asked for, through the context's calls: images of
 * every target (1D, 2D, cube faces, 3D, the arrays), boxes written into them,
 * read back by glGetTexImage in another layout, the level queries of OpenGL
 * 3.0, compressed RGTC blocks, and the RGBA bytes the processor's rasteriser
 * samples. Every expectation follows from OpenGL 4.6 sections 8.4 to 8.7.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { SIZED_FORMATS, TEX } from './formats.js';
import { blankStorage, copyBox, rgbaOf, storageBytes, uncompressedTwin } from './texture-levels.js';

function gl(){
    const bytes = new Uint8Array(0x10000);
    /** @type {string[]} */
    const said = [];
    /** @type {any} */
    const context = createGlContext({
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
        },
        divergence: detail=>said.push(detail),
    });
    context.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    context.glPixelStorei(GL.PACK_ALIGNMENT, 1);
    return { context, bytes, said };
}

/** @param {ArrayBufferView} view */
const bytesOf = view=>new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/**
 * @param {any} context @param {number} target
 * @param {number} format @param {number} type
 * @returns {Uint8Array}
 */
function read(context, target, format, type){
    const answer = context.glGetTexImage(target, 0, format, type);
    assert.ok(answer && !(answer instanceof Uint8Array), 'a sized level packs its own answer');
    return answer.packed;
}

/** @param {any} context @param {number} target @param {number} parameter */
const level = (context, target, parameter)=>
    context.glGetTexLevelParameteriv(target, 0, parameter)[0];

test('a float texture keeps its floats, and reads back as floats or clamped bytes', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    const floats = Float32Array.from([-1.5, 0.25, 2, 1e6]);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.R32F, 2, 2, 0, GL.RED, GL.FLOAT, bytesOf(floats));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(Array.from(new Float32Array(read(context, GL.TEXTURE_2D, GL.RED,
        GL.FLOAT).buffer)), [-1.5, 0.25, 2, 1e6]);
    assert.deepEqual(Array.from(read(context, GL.TEXTURE_2D, GL.RED, GL.UNSIGNED_BYTE)),
        [0, 64, 255, 255]);
    // An RGBA read of a red texture: green and blue zero, alpha one.
    assert.deepEqual(Array.from(new Float32Array(read(context, GL.TEXTURE_2D, GL.RGBA,
        GL.FLOAT).buffer).subarray(4, 8)), [0.25, 0, 0, 1]);
    assert.equal(level(context, GL.TEXTURE_2D, GL.TEXTURE_INTERNAL_FORMAT), TEX.R32F);
    assert.equal(level(context, GL.TEXTURE_2D, GL.TEXTURE_RED_SIZE), 32);
    assert.equal(level(context, GL.TEXTURE_2D, GL.TEXTURE_GREEN_SIZE), 0);
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_RED_TYPE), GL.FLOAT);
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_GREEN_TYPE), GL.NONE);
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_DEPTH), 1);
});

test('integer textures take only integer layouts, and keep the integers', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    const ints = Int16Array.from([-300, 7, 32767, -32768]);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RG16I, 2, 1, 0, TEX.RG_INTEGER, GL.SHORT,
        bytesOf(ints));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(Array.from(new Int32Array(read(context, GL.TEXTURE_2D, TEX.RGBA_INTEGER,
        GL.INT).buffer)), [-300, 7, 0, 1, 32767, -32768, 0, 1]);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RG16I, 2, 1, 0, TEX.RG, GL.SHORT, bytesOf(ints));
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'a normalised layout');
    context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.FLOAT);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'read back as normalised');
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_RED_TYPE), GL.INT);
});

test('the errors of an image call of a sized format', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    const data = new Uint8Array(64);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 1, 1, 0, GL.RGBA,
        GL.UNSIGNED_SHORT_5_6_5, data);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'a packed type of another format');
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 1, 1, 0, 0x1234, GL.FLOAT, data);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 1, 1, 1, GL.RGBA, GL.FLOAT, data);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'a border');
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.DEPTH_COMPONENT24, 1, 1, 0, GL.RGBA, GL.FLOAT,
        data);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'colour into depth');
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.R8, 1, 1, 0, GL.RED, GL.UNSIGNED_BYTE, data);
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 1, 0, 1, 1, GL.RED, GL.UNSIGNED_BYTE, data);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'a box past the level');
    context.glTexImage3D(GL.TEXTURE_3D, 0, TEX.DEPTH_COMPONENT24, 1, 1, 1, 0,
        GL.DEPTH_COMPONENT, GL.FLOAT, null);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'a 3D depth texture');
});

test('depth and stencil formats answer their sizes and read back their depths', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    const words = Uint32Array.from([0xffffff00 | 0x2a, 0x00000080]);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.DEPTH24_STENCIL8, 2, 1, 0, GL.DEPTH_STENCIL,
        GL.UNSIGNED_INT_24_8, bytesOf(words));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(Array.from(new Uint32Array(read(context, GL.TEXTURE_2D, GL.DEPTH_STENCIL,
        GL.UNSIGNED_INT_24_8).buffer)), [0xffffff2a, 0x80]);
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_DEPTH_SIZE), 24);
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_STENCIL_SIZE), 8);
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_DEPTH_TYPE), GL.UNSIGNED_NORMALIZED);
    assert.equal(level(context, GL.TEXTURE_2D, GL.TEXTURE_RED_SIZE), 0);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGB9_E5, 1, 1, 0, GL.RGB, GL.FLOAT,
        bytesOf(Float32Array.from([1, 0.5, 0])));
    assert.equal(level(context, GL.TEXTURE_2D, TEX.TEXTURE_SHARED_SIZE), 5);
    assert.deepEqual(Array.from(new Float32Array(read(context, GL.TEXTURE_2D, GL.RGB,
        GL.FLOAT).buffer)), [1, 0.5, 0]);
});

test('the comparison of a depth texture is state with its own values', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_MODE),
        [GL.NONE]);
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_FUNC),
        [GL.LEQUAL]);
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, TEX.DEPTH_TEXTURE_MODE),
        [GL.LUMINANCE]);
    context.glTexParameteri(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_MODE, TEX.COMPARE_REF_TO_TEXTURE);
    context.glTexParameteri(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_FUNC, GL.GREATER);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_FUNC),
        [GL.GREATER]);
    context.glTexParameteri(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_MODE, GL.LINEAR);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glTexParameteri(GL.TEXTURE_2D, TEX.TEXTURE_COMPARE_FUNC, GL.LINEAR);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('a 3D texture keeps its slices, and a box goes into the slice it names', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_3D, name);
    assert.deepEqual(context.glGetIntegerv(TEX.TEXTURE_BINDING_3D), [name]);
    const texels = new Uint8Array(2 * 2 * 2 * 4).map((_, i)=>i);
    context.glTexImage3D(GL.TEXTURE_3D, 0, GL.RGBA8, 2, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        texels);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(level(context, GL.TEXTURE_3D, TEX.TEXTURE_DEPTH), 2);
    context.glTexSubImage3D(GL.TEXTURE_3D, 0, 1, 0, 1, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([200, 201, 202, 203]));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const back = read(context, GL.TEXTURE_3D, GL.RGBA, GL.UNSIGNED_BYTE);
    const expected = texels.slice();
    expected.set([200, 201, 202, 203], (1 * 4 + 0 * 2 + 1) * 4);
    assert.deepEqual(back, expected);
    context.glTexSubImage3D(GL.TEXTURE_3D, 0, 0, 0, 2, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        texels);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'a slice past the depth');
    context.glTexImage2D(GL.TEXTURE_3D, 0, GL.RGBA8, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, texels);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'a 2D call on a 3D target');
});

test('a legacy format given a 3D target keeps its own components, as a 2D level does', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_3D, name);
    context.glTexImage3D(GL.TEXTURE_3D, 0, GL.LUMINANCE, 1, 1, 2, 0, GL.LUMINANCE_ALPHA,
        GL.UNSIGNED_BYTE, Uint8Array.from([10, 20, 30, 40]));
    // Read back by table 6.1 of 2.1: luminance is red, green and blue zero.
    assert.deepEqual(Array.from(read(context, GL.TEXTURE_3D, GL.RGBA, GL.UNSIGNED_BYTE)),
        [10, 0, 0, 255, 30, 0, 0, 255]);
    assert.equal(level(context, GL.TEXTURE_3D, GL.TEXTURE_INTERNAL_FORMAT), GL.LUMINANCE);
});

test('the image height and skipped images of the unpack state lay out 3D sources', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(TEX.TEXTURE_2D_ARRAY, name);
    context.glPixelStorei(TEX.UNPACK_IMAGE_HEIGHT, 3);
    context.glPixelStorei(TEX.UNPACK_SKIP_IMAGES, 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    // Images of 2x3 bytes a layer, the first skipped; two rows of each are taken.
    const source = new Uint8Array(18).map((_, i)=>i);
    context.glTexImage3D(TEX.TEXTURE_2D_ARRAY, 0, TEX.R8, 2, 2, 2, 0, GL.RED, GL.UNSIGNED_BYTE,
        source);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(Array.from(read(context, TEX.TEXTURE_2D_ARRAY, GL.RED, GL.UNSIGNED_BYTE)),
        [6, 7, 8, 9, 12, 13, 14, 15]);
    assert.deepEqual(context.glGetIntegerv(TEX.UNPACK_IMAGE_HEIGHT), [3]);
});

test('a 2D array takes a layer at a time', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(TEX.TEXTURE_2D_ARRAY, name);
    context.glTexImage3D(TEX.TEXTURE_2D_ARRAY, 0, TEX.RG8, 1, 1, 3, 0, TEX.RG,
        GL.UNSIGNED_BYTE, null);
    context.glTexSubImage3D(TEX.TEXTURE_2D_ARRAY, 0, 0, 0, 2, 1, 1, 1, TEX.RG, GL.UNSIGNED_BYTE,
        Uint8Array.from([9, 8]));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(Array.from(read(context, TEX.TEXTURE_2D_ARRAY, TEX.RG, GL.UNSIGNED_BYTE)),
        [0, 0, 0, 0, 9, 8]);
    assert.deepEqual(context.glGetIntegerv(TEX.TEXTURE_BINDING_2D_ARRAY), [name]);
});

test('a list replays a sized image as it was given, whatever the unpack state then', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    const list = context.glGenLists(1);
    context.glNewList(list, GL.COMPILE);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RG16F, 1, 1, 0, TEX.RG, GL.FLOAT,
        bytesOf(Float32Array.from([0.5, 2])));
    context.glEndList();
    context.glPixelStorei(GL.UNPACK_SKIP_PIXELS, 3);
    context.glCallList(list);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(Array.from(new Float32Array(read(context, GL.TEXTURE_2D, TEX.RG,
        GL.FLOAT).buffer)), [0.5, 2]);
});

test('RGTC blocks are kept as blocks and decode for the processor', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    // One BC4 block, both endpoints 255: every texel 255.
    const block = Uint8Array.from([255, 255, 0, 0, 0, 0, 0, 0]);
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, TEX.COMPRESSED_RED_RGTC1, 4, 4, 0, 8,
        block);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(level(context, GL.TEXTURE_2D, GL.TEXTURE_COMPRESSED), 1);
    assert.deepEqual(Array.from(read(context, GL.TEXTURE_2D, GL.RGBA, GL.UNSIGNED_BYTE)
        .subarray(0, 8)), [255, 0, 0, 255, 255, 0, 0, 255]);
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, TEX.COMPRESSED_RED_RGTC1, 4, 4, 0, 16,
        block);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'the wrong size');
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, TEX.COMPRESSED_RED_RGTC1, 8, 4, 0, 16,
        new Uint8Array(16));
    context.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0, 4, 0, 4, 4, TEX.COMPRESSED_RED_RGTC1,
        8, block);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const both = read(context, GL.TEXTURE_2D, GL.RED, GL.UNSIGNED_BYTE);
    assert.deepEqual([both[0], both[4]], [0, 255], 'only the second block written');
    context.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0, 2, 0, 4, 4, TEX.COMPRESSED_RED_RGTC1,
        8, block);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'off the block grid');
    const blocks = context.glGetCompressedTexImageARB(GL.TEXTURE_2D, 0);
    assert.deepEqual(Array.from(blocks), [...new Uint8Array(8), ...block], 'its blocks back');
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.R8, 1, 1, 0, GL.RED, GL.UNSIGNED_BYTE,
        new Uint8Array(1));
    assert.equal(context.glGetCompressedTexImageARB(GL.TEXTURE_2D, 0), null);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'not a compressed level');
});

test('a glTexImage of a compressed format keeps its uncompressed twin', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.COMPRESSED_RG_RGTC2, 1, 1, 0, TEX.RG,
        GL.UNSIGNED_BYTE, Uint8Array.from([7, 9]));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(level(context, GL.TEXTURE_2D, GL.TEXTURE_INTERNAL_FORMAT),
        TEX.COMPRESSED_RG_RGTC2);
    assert.deepEqual(Array.from(read(context, GL.TEXTURE_2D, TEX.RG, GL.UNSIGNED_BYTE)), [7, 9]);
    const twin = (/** @type {number} */ internal)=>uncompressedTwin(
        /** @type {any} */ (SIZED_FORMATS.get(internal))).name;
    assert.equal(twin(TEX.COMPRESSED_SIGNED_RED_RGTC1), 'R8_SNORM');
    assert.equal(twin(TEX.COMPRESSED_RGB_BPTC_SIGNED_FLOAT), 'RGBA16F');
    assert.equal(twin(TEX.COMPRESSED_SRGB_ALPHA_BPTC_UNORM), 'SRGB8_ALPHA8');
    assert.equal(twin(TEX.COMPRESSED_RGBA_BPTC_UNORM), 'RGBA8');
});

test('a legacy level takes the layouts OpenGL 3.0 added (RG, half floats)', ()=>{
    const { context } = gl();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, 0, GL.RGBA, TEX.HALF_FLOAT,
        bytesOf(Uint16Array.from([0x3c00, 0x3800, 0, 0x3c00])));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const texels = context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.ok(texels instanceof Uint8Array);
    assert.deepEqual(Array.from(texels), [255, 128, 0, 255]);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, 0, TEX.RGBA_INTEGER, GL.BYTE,
        new Uint8Array(4));
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'an integer layout');
    // And a legacy level reads back in a new layout too.
    assert.deepEqual(Array.from(new Float32Array(read(context, GL.TEXTURE_2D, TEX.RG,
        GL.FLOAT).buffer)), [1, Math.fround(128 / 255)]);
});

test('the processor samples a sized level through its RGBA bytes', ()=>{
    const rg8 = /** @type {any} */ (SIZED_FORMATS.get(TEX.RG8));
    assert.deepEqual(Array.from(/** @type {Uint8Array} */ (rgbaOf(Uint8Array.from([3, 4]), rg8,
        1, 1, 1))), [3, 4, 0, 255]);
    const depth = /** @type {any} */ (SIZED_FORMATS.get(TEX.DEPTH_COMPONENT16));
    assert.deepEqual(Array.from(/** @type {Uint8Array} */ (rgbaOf(Uint8Array.from([0xff, 0xff]),
        depth, 1, 1, 1))), [255, 255, 255, 255]);
    const half = /** @type {any} */ (SIZED_FORMATS.get(TEX.RGBA16F));
    assert.deepEqual(Array.from(/** @type {Uint8Array} */ (rgbaOf(bytesOf(Uint16Array.from(
        [0x4000, 0xbc00, 0x3800, 0x3c00])), half, 1, 1, 1))), [255, 0, 128, 255]);
    const rgb = /** @type {any} */ (SIZED_FORMATS.get(TEX.RGB16F));
    assert.deepEqual(Array.from(new Uint16Array(blankStorage(rgb, 1, 1, 1).buffer)),
        [0, 0, 0, 0x3c00], 'a blank RGB level reads alpha one');
});

test('a box goes into a level and comes out of it, blocks for a compressed format', ()=>{
    const r8 = /** @type {any} */ (SIZED_FORMATS.get(TEX.R8));
    const image = new Uint8Array(4 * 3 * 2);
    const box = { x: 1, y: 1, z: 1, width: 2, height: 2, depth: 1 };
    copyBox(image, r8, 4, 3, box, Uint8Array.from([1, 2, 3, 4]), 'write');
    assert.deepEqual(Array.from(image.subarray(12)), [0, 0, 0, 0, 0, 1, 2, 0, 0, 3, 4, 0]);
    const out = new Uint8Array(4);
    copyBox(image, r8, 4, 3, box, out, 'read');
    assert.deepEqual(Array.from(out), [1, 2, 3, 4]);
    const bc5 = /** @type {any} */ (SIZED_FORMATS.get(TEX.COMPRESSED_RG_RGTC2));
    assert.equal(storageBytes(bc5, 8, 6), 2 * 2 * 16);
    const blocks = new Uint8Array(storageBytes(bc5, 8, 8));
    copyBox(blocks, bc5, 8, 8, { x: 4, y: 4, z: 0, width: 4, height: 4, depth: 1 },
        new Uint8Array(16).fill(7), 'write');
    assert.deepEqual([blocks[47], blocks[48], blocks[63]], [0, 7, 7]);
});
