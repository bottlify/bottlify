/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which levels a mipmapped texture needs before it is sampled: the ones
 * GL_GENERATE_MIPMAP (1.4) makes from the base level, and no more than
 * GL_TEXTURE_MAX_LEVEL (1.2) names. A texture judged incomplete is sampled as
 * the placeholder, which is how a font atlas loaded with only its top level
 * and generate-mipmap set drew every glyph as a blank box.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { TEX } from './formats.js';

function gl(){
    const bytes = new Uint8Array(0x10000);
    /** @type {any} */
    const context = createGlContext({
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
        },
    });
    context.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    return context;
}

/** @param {any} context @param {number} level */
const widthAt = (context, level)=>
    context.glGetTexLevelParameteriv(GL.TEXTURE_2D, level, GL.TEXTURE_WIDTH)[0];

for (const [kind, internal] of /** @type {const} */ ([['sized', GL.RGBA8], ['unsized', GL.RGBA]]))
{
    test(`GL_GENERATE_MIPMAP makes the levels below a base image glTexImage2D gives (${kind}),`
        + ' and the texture is complete', ()=>{
        const context = gl();
        context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
        context.glTexImage2D(GL.TEXTURE_2D, 0, internal, 8, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array(8 * 4 * 4).fill(200));
        assert.deepEqual([1, 2, 3].map(level=>widthAt(context, level)), [4, 2, 1]);
        assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
        assert.equal(context.glGetError(), GL.NO_ERROR);
    });
}

test('without GL_GENERATE_MIPMAP a mipmap-filtered texture with only its top level is'
    + ' incomplete', ()=>{
    const context = gl();
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 8, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(8 * 4 * 4));
    assert.equal(widthAt(context, 1), 0);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), false);
});

test('GL_GENERATE_MIPMAP set after the image: glTexSubImage2D of the base level makes the'
    + ' levels', ()=>{
    const context = gl();
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 4 * 4));
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), false, 'nothing made yet');
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(2 * 2 * 4));
    assert.deepEqual([1, 2].map(level=>widthAt(context, level)), [2, 1]);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
});

test('a chain stopped short of 1x1 is complete when GL_TEXTURE_MAX_LEVEL ends it there,'
    + ' and incomplete when it does not', ()=>{
    const context = gl();
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 8, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(8 * 4 * 4));
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 4, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 2 * 4));
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), false, 'levels 2 and 3 missing');
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
});

/** @param {any} context @param {number} target */
function bindNew(context, target){
    const [name] = context.glGenTextures(1);
    context.glBindTexture(target, name);
    return name;
}

/** @param {number} w @param {number} h */
const rgba = (w, h)=>new Uint8Array(w * h * 4).fill(200);

test('3.8.8 (1.4): GL_GENERATE_MIPMAP makes the levels of a cube face', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_CUBE_MAP);
    context.glTexParameteri(GL.TEXTURE_CUBE_MAP, GL.GENERATE_MIPMAP, GL.TRUE);
    for (let face = 0; face < 6; face++)
    {
        context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL.RGBA, 4, 4, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, rgba(4, 4));
    }
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_CUBE_MAP_NEGATIVE_Z, 2,
        GL.TEXTURE_WIDTH), [1]);
    assert.equal(context.isTextureComplete(GL.TEXTURE_CUBE_MAP), true);
});

test('3.8.8 (1.4): GL_GENERATE_MIPMAP makes the levels of a compressed base image', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 8, 8,
        0, 32, new Uint8Array(32));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
});

test('3.8.8 (1.4): GL_GENERATE_MIPMAP makes the levels of a 1D image', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_1D);
    context.glTexParameteri(GL.TEXTURE_1D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexImage1D(GL.TEXTURE_1D, 0, GL.RGBA, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(4, 1));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(context.isTextureComplete(GL.TEXTURE_1D), true);
});

test('3.8.8 (1.4): GL_GENERATE_MIPMAP makes levels from BASE_LEVEL down, not from level 0', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_2D);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(8, 8));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, rgba(2, 2));
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 2, GL.TEXTURE_WIDTH), [1]);
});

test('3.8.8 (1.4): GL_GENERATE_MIPMAP of one cube face remakes that face alone', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_CUBE_MAP);
    for (let face = 0; face < 6; face++)
    {
        context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL.RGBA, 2, 2, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, rgba(2, 2));
        context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 1, GL.RGBA, 1, 1, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, Uint8Array.of(face, 0, 0, 255));
    }
    context.glTexParameteri(GL.TEXTURE_CUBE_MAP, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexSubImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 0, 0, 0, 2, 2, GL.RGBA,
        GL.UNSIGNED_BYTE, new Uint8Array(16).fill(100));
    /** @param {number} face */
    const small = face=>Array.from(context.glGetTexImage(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 1,
        GL.RGBA, GL.UNSIGNED_BYTE));
    assert.deepEqual(small(1), [100, 100, 100, 100], 'the face written');
    assert.deepEqual(small(0), [0, 0, 0, 255], 'another face keeps its own level');
    assert.deepEqual(small(5), [5, 0, 0, 255]);
});

test('3.0 3.8.8: glGenerateMipmap of a 3D texture halves its slices too, averaging them', ()=>{
    const context = gl();
    bindNew(context, GL.TEXTURE_3D);
    context.glTexImage3D(GL.TEXTURE_3D, 0, GL.RGBA8, 2, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from({ length: 32 }, (_, k)=>(k < 16 ? 0 : 200)));
    context.glGenerateMipmap(GL.TEXTURE_3D);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_3D, 1, TEX.TEXTURE_DEPTH), [1]);
    const answer = context.glGetTexImage(GL.TEXTURE_3D, 1, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual(Array.from(answer.packed), [100, 100, 100, 100]);
    context.glTexParameteri(GL.TEXTURE_3D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    assert.equal(context.isTextureComplete(GL.TEXTURE_3D), true);
});

test('3.8.8: generated levels end at GL_TEXTURE_MAX_LEVEL', ()=>{
    const context = gl();
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        rgba(8, 8));
    assert.equal(widthAt(context, 1), 4);
    assert.equal(widthAt(context, 2), 0, 'no level past MAX_LEVEL');
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
});
