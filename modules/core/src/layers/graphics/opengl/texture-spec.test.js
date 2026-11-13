/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texturing rules of OpenGL 1.2-2.1 (glspec21 3.8, 6.1.3-6.1.4), one case per
 * rule: completeness from the base level, proxies, generate-mipmap on every
 * target, the LOD bias, combiner sources, level queries and reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { sample2D } from './texture.js';
import { packImage } from './context-pixels.js';

/** @type {string[]} what the last context made said */
let said = [];

function gl(){
    const bytes = new Uint8Array(0x10000);
    said = [];
    /** @type {any} */
    const context = createGlContext({
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
        },
        divergence: (/** @type {string} */ detail)=>said.push(detail),
    });
    context.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    return context;
}

/** @param {any} context @param {number} target */
function bindNew(context, target){
    const [name] = context.glGenTextures(1);
    context.glBindTexture(target, name);
    return name;
}

/** @param {number} w @param {number} h */
const rgba = (w, h)=>new Uint8Array(w * h * 4).fill(200);

test('3.8.10: completeness starts at GL_TEXTURE_BASE_LEVEL, not level 0', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    // Levels 1 and 2 only; level 0 never specified.
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(2, 2));
    context.glTexImage2D(GL.TEXTURE_2D, 2, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(1, 1));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
});

test('3.8.10: a level below BASE_LEVEL of a different size does not make it incomplete', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(1, 1));
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(4, 4));
    context.glTexImage2D(GL.TEXTURE_2D, 2, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(2, 2));
    context.glTexImage2D(GL.TEXTURE_2D, 3, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(1, 1));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
});

test('3.8.10: cube completeness needs one internal format on all six faces', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_CUBE_MAP);
    context.glTexParameteri(GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    for (let face = 0; face < 6; face++)
    {
        context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0,
            face === 3 ? GL.LUMINANCE : GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(2, 2));
    }
    assert.equal(context.isTextureComplete(GL.TEXTURE_CUBE_MAP), false);
});

test('3.8.1: a border is part of the width given, and the chain halves the interior', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    // 4x4 interior with a one-texel border: 6x6, then 2x2 + border = 4x4, then 1x1 + border = 3x3.
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 6, 6, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba(6, 6));
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 4, 4, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba(4, 4));
    context.glTexImage2D(GL.TEXTURE_2D, 2, GL.RGBA, 3, 3, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba(3, 3));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
    assert.ok(said.some(detail=>detail.includes('border texels as part of the image')));
});

test('3.8.1: a proxy image sets the proxy state glGetTexLevelParameter reads', ()=>{
    const context = gl();
    context.glTexImage2D(GL.PROXY_TEXTURE_2D, 0, GL.RGBA, 64, 32, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        null);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.PROXY_TEXTURE_2D, 0, GL.TEXTURE_WIDTH),
        [64]);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.PROXY_TEXTURE_2D, 0, GL.TEXTURE_HEIGHT),
        [32]);
    assert.equal(context.glGetError(), GL.NO_ERROR);
});

test('3.8.1: a proxy image too large sets the proxy state to zero, with no error', ()=>{
    const context = gl();
    context.glTexImage2D(GL.PROXY_TEXTURE_2D, 0, GL.RGBA, 1 << 16, 4, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, null);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.PROXY_TEXTURE_2D, 0, GL.TEXTURE_WIDTH),
        [0]);
});

test('3.8.8 (1.4): GL_TEXTURE_LOD_BIAS is a texture parameter, default 0', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    const TEXTURE_LOD_BIAS = 0x8501;
    assert.deepEqual(context.glGetTexParameterfv(GL.TEXTURE_2D, TEXTURE_LOD_BIAS), [0]);
    assert.equal(said.length, 0);
    context.glTexParameterf(GL.TEXTURE_2D, TEXTURE_LOD_BIAS, -0.5);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexParameterfv(GL.TEXTURE_2D, TEXTURE_LOD_BIAS), [-0.5]);
    assert.ok(said.some(detail=>detail.includes('GL_TEXTURE_LOD_BIAS')), 'not applied, said');
    assert.deepEqual(context.glGetFloatv(GL.MAX_TEXTURE_LOD_BIAS), [16]);
});

test('3.8.8 (1.4): GL_TEXTURE_FILTER_CONTROL takes the unit LOD bias', ()=>{
    const context = gl();
    const TEXTURE_FILTER_CONTROL = 0x8500;
    const TEXTURE_LOD_BIAS = 0x8501;
    context.glTexEnvf(TEXTURE_FILTER_CONTROL, TEXTURE_LOD_BIAS, 1.5);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexEnvfv(TEXTURE_FILTER_CONTROL, TEXTURE_LOD_BIAS), [1.5]);
});

test('3.8.13 (1.4): a combiner source may name another unit, GL_TEXTUREn', ()=>{
    const context = gl();
    context.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.COMBINE);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.SOURCE1_RGB, GL.TEXTURE0 + 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.SOURCE1_RGB), [GL.TEXTURE0 + 1]);
    assert.ok(said.some(detail=>detail.includes('GL_TEXTUREn')), 'read as GL_PREVIOUS, said');
    context.glTexEnvi(GL.TEXTURE_ENV, GL.SOURCE1_RGB, GL.TEXTURE0 + 64);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'no such unit');
});

test('6.1.3: GL_TEXTURE_BORDER is a level query', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 3, 3, 1, GL.RGBA, GL.UNSIGNED_BYTE, rgba(3, 3));
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, 0x1005), [1]);
    assert.equal(context.glGetError(), GL.NO_ERROR);
});

test('6.1.3: a LUMINANCE level has no red, green or blue component', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE8, 1, 1, 0, GL.LUMINANCE,
        GL.UNSIGNED_BYTE, Uint8Array.of(9));
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_RED_SIZE), [0]);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, 0x8060), [8]);
});

test('3.8.15 (1.2): GL_TEXTURE_3D is a unit enable on the fixed path', ()=>{
    const context = gl();
    context.glEnable(GL.TEXTURE_3D);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(context.glIsEnabled(GL.TEXTURE_3D), GL.TRUE);
    context.glActiveTextureARB(GL.TEXTURE0 + 1);
    assert.equal(context.glIsEnabled(GL.TEXTURE_3D), GL.FALSE, 'per unit');
});

test('3.8.1 (2.1): the sRGB luminance formats are internal formats', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    for (const internal of [0x8c44, 0x8c45, 0x8c46, 0x8c47])
    {
        context.glTexImage2D(GL.TEXTURE_2D, 0, internal, 1, 1, 0, GL.LUMINANCE_ALPHA,
            GL.UNSIGNED_BYTE, Uint8Array.of(1, 2));
        assert.equal(context.glGetError(), GL.NO_ERROR, internal.toString(16));
    }
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, 0x8060), [8],
        'SLUMINANCE8 is luminance');
    assert.ok(said.some(detail=>detail.includes('sRGB luminance')), 'no sRGB decode, said');
});

test('3.8.1: a level past log2(max) of one cube face never lands on another face', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_CUBE_MAP);
    context.glTexImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 0, GL.RGBA, 4, 4, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, rgba(4, 4));
    context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 32, GL.RGBA, 1, 1, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, rgba(1, 1));
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 0,
        GL.TEXTURE_WIDTH), [4]);
});

test('3.8.2: glCopyTexImage2D refuses a height past GL_MAX_TEXTURE_SIZE', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glCopyTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 0, 0, 1, 1 << 16, 0);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

test('3.8.10: a texture whose BASE_LEVEL is past its MAX_LEVEL is incomplete', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(4, 4));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 2);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), false);
});

test('3.8.13 (2.0): glTexEnv takes GL_POINT_SPRITE, GL_COORD_REPLACE', ()=>{
    const context = gl();
    context.glTexEnvi(GL.POINT_SPRITE, GL.COORD_REPLACE, GL.TRUE);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexEnviv(GL.POINT_SPRITE, GL.COORD_REPLACE), [GL.TRUE]);
    assert.ok(said.some(detail=>detail.includes('GL_COORD_REPLACE')), 'not done, said');
});

test('6.1.4: glGetTexImage of a LUMINANCE level as RGBA reads (L, 0, 0, 1)', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE, 1, 1, 0, GL.LUMINANCE,
        GL.UNSIGNED_BYTE, Uint8Array.of(90));
    const texels = context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual(Array.from(texels), [90, 0, 0, 255]);
});

test('6.1.4: glGetTexImage packs into a packed type (BGRA, UNSIGNED_INT_8_8_8_8_REV)', ()=>{
    const packed = packImage(Uint8Array.of(1, 2, 3, 4), 1, 1, GL.BGRA,
        GL.UNSIGNED_INT_8_8_8_8_REV, { alignment: 4, rowLength: 0, skipRows: 0, skipPixels: 0 });
    assert.ok(packed, 'a packed type is a valid layout for a read');
    assert.deepEqual(Array.from(packed), [3, 2, 1, 4]);
});

test('GL_CLAMP is sampled as GL_CLAMP_TO_EDGE (decisions A242), and says so', ()=>{
    // A 2x1 white texture, border colour black: GL blends half the border in
    // at s = 0; here the edge texel is read, as the device reads it.
    const image = { width: 2, height: 1, texels: new Uint8Array(8).fill(255) };
    /** @param {number} wrap */
    const edge = wrap=>sample2D(image, { magFilter: GL.LINEAR, minFilter: GL.LINEAR,
        wrapS: wrap, wrapT: wrap }, 0, 0.5)[0];
    assert.equal(edge(GL.CLAMP), edge(GL.CLAMP_TO_EDGE));
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    assert.equal(said.length, 0);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.ok(said.some(detail=>detail.includes('GL_CLAMP is sampled as GL_CLAMP_TO_EDGE')));
});

test('3.8.16: a unit samples its highest enabled target, cube over 3D over 2D', ()=>{
    const context = gl();
    const flat = bindNew(context, GL.TEXTURE_2D);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(1, 1));
    bindNew(context, GL.TEXTURE_3D);
    context.glTexParameteri(GL.TEXTURE_3D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage3D(GL.TEXTURE_3D, 0, GL.RGBA, 1, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        rgba(1, 1));
    context.glEnable(GL.TEXTURE_2D);
    assert.deepEqual(context.side.activeTextures().map((/** @type {any} */ e)=>e.texture.name),
        [flat]);
    context.glEnable(GL.TEXTURE_3D);
    // The fixed pipeline does not sample a 3D image: the unit draws as if
    // disabled, and the loss is said - not the 2D texture beneath it.
    assert.deepEqual(context.side.activeTextures(), []);
    assert.ok(said.some(detail=>detail.includes('3D texture enabled on the fixed pipeline')));
    const cube = bindNew(context, GL.TEXTURE_CUBE_MAP);
    context.glTexParameteri(GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    for (let face = 0; face < 6; face++)
    {
        context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL.RGBA, 1, 1, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, rgba(1, 1));
    }
    context.glEnable(GL.TEXTURE_CUBE_MAP);
    assert.deepEqual(context.side.activeTextures().map((/** @type {any} */ e)=>e.texture.name),
        [cube]);
});

test('3.8.1: a proxy keeps a compressed image and a glTexStorage shape, and a bad format is'
    + ' still an error', ()=>{
    const context = gl();
    context.glCompressedTexImage2DARB(GL.PROXY_TEXTURE_2D, 0, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT,
        8, 8, 0, 32, null);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.PROXY_TEXTURE_2D, 0,
        GL.TEXTURE_COMPRESSED), [1]);
    context.glTexStorage2D(GL.PROXY_TEXTURE_2D, 3, GL.RGBA8, 16, 8);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.PROXY_TEXTURE_2D, 2, GL.TEXTURE_WIDTH),
        [4]);
    context.glTexImage2D(GL.PROXY_TEXTURE_2D, 0, 0x1234, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        null);
    assert.notEqual(context.glGetError(), GL.NO_ERROR);
    context.glTexImage2D(GL.PROXY_TEXTURE_2D, -1, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        null);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'a negative level');
});

test('3.8.8 (1.4): GL_DEPTH_TEXTURE_MODE is kept, and that it is not read is said', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    const DEPTH_TEXTURE_MODE = 0x884b;
    context.glTexParameteri(GL.TEXTURE_2D, DEPTH_TEXTURE_MODE, GL.LUMINANCE);
    assert.equal(said.length, 0);
    context.glTexParameteri(GL.TEXTURE_2D, DEPTH_TEXTURE_MODE, GL.ALPHA);
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, DEPTH_TEXTURE_MODE), [GL.ALPHA]);
    assert.ok(said.some(detail=>detail.includes('GL_DEPTH_TEXTURE_MODE')));
});
