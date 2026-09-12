/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texture images: what a guest upload turns into, texel for texel.
 *
 * Every expectation is a byte: the unpacking, the S3TC decoding and the
 * sampling are integer arithmetic this file writes down, and a change to any
 * of them is a changed picture that these tests exist to notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import {
    applyTextureEnvironment, baseFormatOf, compressedBytes, createTextureEnvironment,
    cubeFaceOf, decodeS3tc, imageBytes, sample2D, unpackImage,
} from './texture.js';

/**
 * A result that must be there: the test says so before it reads it.
 *
 * @template T
 * @param {T | null} value
 * @returns {T}
 */
function some(value){
    assert.notEqual(value, null);
    return /** @type {T} */ (value);
}

const TIGHT = { alignment: 1, rowLength: 0, skipRows: 0, skipPixels: 0, swapBytes: false };
const DEFAULT = { ...TIGHT, alignment: 4 };

test('the unpack alignment pads rows, and a tightly packed upload read at four shears', ()=>{
    // Three RGB pixels a row is nine bytes; at the default alignment a row
    // starts every twelve. An upload that ignores that reads the second row
    // three bytes early, which is the classic sheared texture.
    const rows = [
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0],
        [11, 12, 13, 14, 15, 16, 17, 18, 19, 0, 0, 0],
    ];
    const padded = Uint8Array.from(rows.flat());
    assert.equal(imageBytes(3, 2, GL.RGB, GL.UNSIGNED_BYTE, DEFAULT), 12 + 9);
    assert.equal(imageBytes(3, 2, GL.RGB, GL.UNSIGNED_BYTE, TIGHT), 18);

    const aligned = some(unpackImage(padded, 3, 2, GL.RGB, GL.UNSIGNED_BYTE, DEFAULT));
    assert.deepEqual([...aligned.subarray(12, 16)], [11, 12, 13, 255], 'second row, first texel');

    const sheared = some(unpackImage(padded, 3, 2, GL.RGB, GL.UNSIGNED_BYTE, TIGHT));
    assert.deepEqual([...sheared.subarray(12, 16)], [0, 0, 0, 255],
        'read tightly, the second row starts in the padding');
});

test('row length and the skips address a window of a larger image', ()=>{
    const image = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++)
    {
        image.set([i, i, i, 255], i * 4);
    }
    const window = some(unpackImage(image, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE,
        { ...TIGHT, rowLength: 4, skipRows: 1, skipPixels: 2 }));
    assert.deepEqual([window[0], window[4], window[8], window[12]], [6, 7, 10, 11]);
});

test('BGRA, luminance and alpha expand to the components the format carries', ()=>{
    const bgra = some(unpackImage(
        Uint8Array.from([1, 2, 3, 4]), 1, 1, GL.BGRA, GL.UNSIGNED_BYTE, TIGHT));
    assert.deepEqual([...bgra], [3, 2, 1, 4]);
    const lum = some(unpackImage(
        Uint8Array.from([9]), 1, 1, GL.LUMINANCE, GL.UNSIGNED_BYTE, TIGHT));
    assert.deepEqual([...lum], [9, 9, 9, 255]);
    const alpha = some(unpackImage(Uint8Array.from([9]), 1, 1, GL.ALPHA, GL.UNSIGNED_BYTE, TIGHT));
    assert.deepEqual([...alpha], [0, 0, 0, 9]);
});

test('a packed 5-6-5 pixel unpacks its fields from the top bit down, scaled to bytes', ()=>{
    // 0xf800 is red only: five ones at the top. 0x07e0 is green only.
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint16(0, 0xf800, true);
    new DataView(bytes.buffer).setUint16(2, 0x07e0, true);
    const texels = some(unpackImage(bytes, 2, 1, GL.RGB, GL.UNSIGNED_SHORT_5_6_5, TIGHT));
    assert.deepEqual([...texels], [255, 0, 0, 255, 0, 255, 0, 255]);

    // The reversed type stores the first component at the bottom, so the
    // same word is blue.
    const reversed = some(unpackImage(bytes, 1, 1, GL.RGB, GL.UNSIGNED_SHORT_5_6_5_REV, TIGHT));
    assert.deepEqual([...reversed], [0, 0, 255, 255]);

    // 4-4-4-4 with an alpha of 0x8 is 8 * 255 / 15, rounded: 136.
    new DataView(bytes.buffer).setUint16(0, 0xf008, true);
    const rgba = some(unpackImage(bytes, 1, 1, GL.RGBA, GL.UNSIGNED_SHORT_4_4_4_4, TIGHT));
    assert.deepEqual([...rgba], [255, 0, 0, 136]);
});

test('a signed byte maps by the (2c + 1) / 255 rule and a float clamps', ()=>{
    const signed = some(unpackImage(
        Uint8Array.from([127, 0x80, 0, 0]), 1, 1, GL.RGBA, GL.BYTE, TIGHT));
    assert.deepEqual([...signed], [255, 0, 1, 1]);
    const floats = new Uint8Array(16);
    new DataView(floats.buffer).setFloat32(0, 0.5, true);
    new DataView(floats.buffer).setFloat32(4, 2, true);
    new DataView(floats.buffer).setFloat32(8, -1, true);
    new DataView(floats.buffer).setFloat32(12, 1, true);
    assert.deepEqual([...some(unpackImage(floats, 1, 1, GL.RGBA, GL.FLOAT, TIGHT))],
        [128, 255, 0, 255]);
});

test('an unreadable layout is refused rather than guessed', ()=>{
    assert.equal(unpackImage(new Uint8Array(8), 1, 1, GL.RGBA, GL.UNSIGNED_SHORT_5_6_5, TIGHT),
        null, 'three fields cannot carry four components');
    assert.equal(unpackImage(new Uint8Array(2), 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, TIGHT), null,
        'too few bytes');
    assert.equal(baseFormatOf(0xdead), null);
    assert.equal(baseFormatOf(3), GL.RGB);
    assert.equal(baseFormatOf(GL.RGBA8), GL.RGBA);
    assert.equal(baseFormatOf(GL.COMPRESSED_RGBA_S3TC_DXT5_EXT), GL.RGBA);
});

test('a DXT1 block decodes its two colours, their two blends, and its transparent index', ()=>{
    // colour0 = pure red in 5-6-5 (0xf800), colour1 = pure blue (0x001f).
    // colour0 > colour1, so four colours are interpolated. The index word
    // walks 0, 1, 2, 3 across the first row and is 0 elsewhere.
    const block = new Uint8Array(8);
    const view = new DataView(block.buffer);
    view.setUint16(0, 0xf800, true);
    view.setUint16(2, 0x001f, true);
    view.setUint32(4, 0b11100100, true);
    assert.equal(compressedBytes(GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4), 8);
    const texels = some(decodeS3tc(block, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4));
    const texel = (/** @type {number} */ i)=>[...texels.subarray(i * 4, i * 4 + 4)];
    assert.deepEqual(texel(0), [255, 0, 0, 255]);
    assert.deepEqual(texel(1), [0, 0, 255, 255]);
    assert.deepEqual(texel(2), [170, 0, 85, 255], 'two thirds of colour0');
    assert.deepEqual(texel(3), [85, 0, 170, 255], 'one third');

    // With colour0 <= colour1 the block has three colours and index 3 is
    // transparent black for the RGBA format, opaque black for RGB.
    view.setUint16(0, 0x001f, true);
    view.setUint16(2, 0xf800, true);
    const rgba = some(decodeS3tc(block, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 4, 4));
    assert.deepEqual([...rgba.subarray(8, 12)], [128, 0, 128, 255], 'the midpoint');
    assert.deepEqual([...rgba.subarray(12, 16)], [0, 0, 0, 0]);
    const rgb = some(decodeS3tc(block, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4));
    assert.deepEqual([...rgb.subarray(12, 16)], [0, 0, 0, 255]);

    // A 2x2 image is still one block, and only its corner is kept.
    assert.equal(compressedBytes(GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 2, 2), 8);
    assert.equal(some(decodeS3tc(block, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 2, 2)).length, 16);
    assert.equal(decodeS3tc(block, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 8, 8), null, 'too few bytes');
});

test('DXT3 carries explicit alpha nibbles and DXT5 interpolates eight', ()=>{
    const block = new Uint8Array(16);
    const view = new DataView(block.buffer);
    // DXT3: the first texel's nibble is 0xf, the second's 0x8.
    view.setUint16(0, 0x008f, true);
    view.setUint16(8, 0xffff, true);
    view.setUint16(10, 0xffff, true);
    const dxt3 = some(decodeS3tc(block, GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, 4, 4));
    assert.deepEqual([...dxt3.subarray(0, 4)], [255, 255, 255, 255]);
    assert.deepEqual([...dxt3.subarray(4, 8)], [255, 255, 255, 136]);
    assert.deepEqual([...dxt3.subarray(8, 12)], [255, 255, 255, 0]);

    // DXT5: alpha0 = 255, alpha1 = 0, so the table is 255, 0, 219, 182, ...;
    // the first texel's three index bits are 0b010, the second's 0b001.
    block.fill(0);
    block[0] = 255;
    block[1] = 0;
    block[2] = 0b001010;
    view.setUint16(8, 0xffff, true);
    view.setUint16(10, 0xffff, true);
    const dxt5 = some(decodeS3tc(block, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 4, 4));
    assert.equal(dxt5[3], 219, '(6 * 255 + 1 * 0) / 7');
    assert.equal(dxt5[7], 0, 'index one is alpha1');
    assert.equal(dxt5[11], 255, 'index zero is alpha0');
});

test('nearest sampling picks the texel under the coordinate and wraps as told', ()=>{
    const image = { width: 2, height: 1, texels: Uint8Array.from([10, 0, 0, 255, 0, 20, 0, 255]) };
    const nearest = { magFilter: GL.NEAREST, minFilter: GL.NEAREST, wrapS: GL.REPEAT,
        wrapT: GL.REPEAT };
    assert.deepEqual(sample2D(image, nearest, 0.25, 0.5), [10, 0, 0, 255]);
    assert.deepEqual(sample2D(image, nearest, 0.75, 0.5), [0, 20, 0, 255]);
    assert.deepEqual(sample2D(image, nearest, 1.25, 0.5), [10, 0, 0, 255], 'repeat wraps');
    assert.deepEqual(sample2D(image, nearest, -0.25, 0.5), [0, 20, 0, 255], 'and wraps backwards');
    const clamped = { ...nearest, wrapS: GL.CLAMP_TO_EDGE };
    assert.deepEqual(sample2D(image, clamped, 1.25, 0.5), [0, 20, 0, 255], 'clamp holds the edge');
    const mirrored = { ...nearest, wrapS: GL.MIRRORED_REPEAT };
    assert.deepEqual(sample2D(image, mirrored, 1.25, 0.5), [0, 20, 0, 255], 'mirror reflects');
});

test('linear sampling blends the two texels whose centres bracket the coordinate', ()=>{
    const image = { width: 2, height: 1, texels: Uint8Array.from([0, 0, 0, 255, 100, 0, 0, 255]) };
    const linear = { magFilter: GL.LINEAR, minFilter: GL.LINEAR, wrapS: GL.CLAMP_TO_EDGE,
        wrapT: GL.CLAMP_TO_EDGE };
    assert.deepEqual(sample2D(image, linear, 0.25, 0.5), [0, 0, 0, 255], 'exactly on a centre');
    assert.deepEqual(sample2D(image, linear, 0.5, 0.5), [50, 0, 0, 255], 'halfway between');
    assert.deepEqual(sample2D(image, linear, 0.375, 0.5), [25, 0, 0, 255]);
    const repeating = { ...linear, wrapS: GL.REPEAT };
    assert.deepEqual(sample2D(image, repeating, 0, 0.5), [50, 0, 0, 255],
        'at the seam a repeating texture blends its two ends');
});

test('a cube map direction picks the face of its major axis', ()=>{
    assert.deepEqual(cubeFaceOf(1, 0, 0), { face: 0, s: 0.5, t: 0.5 });
    assert.deepEqual(cubeFaceOf(-1, 0, 0), { face: 1, s: 0.5, t: 0.5 });
    assert.deepEqual(cubeFaceOf(0, 2, 0.5), { face: 2, s: 0.5, t: 0.625 });
    assert.deepEqual(cubeFaceOf(0, 0, -3), { face: 5, s: 0.5, t: 0.5 });
    assert.deepEqual(cubeFaceOf(0, 0, 0).face, 0, 'no direction is not a fault');
});

test('the texture environment follows the base format, not the texel', ()=>{
    const env = createTextureEnvironment();
    const fragment = [0.5, 0.5, 0.5, 0.5];
    const texel = [1, 0, 0, 0.5];
    const primary = fragment;

    assert.deepEqual(applyTextureEnvironment(env, GL.RGBA, fragment, texel, primary),
        [0.5, 0, 0, 0.25], 'modulate multiplies colour and alpha');
    assert.deepEqual(applyTextureEnvironment(env, GL.RGB, fragment, texel, primary),
        [0.5, 0, 0, 0.5], 'an RGB texture leaves alpha to the fragment');
    assert.deepEqual(applyTextureEnvironment(env, GL.ALPHA, fragment, texel, primary),
        [0.5, 0.5, 0.5, 0.25], 'an alpha texture leaves colour to the fragment');

    env.mode = GL.REPLACE;
    assert.deepEqual(applyTextureEnvironment(env, GL.LUMINANCE, fragment, texel, primary),
        [1, 0, 0, 0.5], 'luminance replaces colour and keeps fragment alpha');

    env.mode = GL.DECAL;
    assert.deepEqual(applyTextureEnvironment(env, GL.RGBA, fragment, texel, primary),
        [0.75, 0.25, 0.25, 0.5], 'decal blends by texel alpha and keeps fragment alpha');

    env.mode = GL.ADD;
    assert.deepEqual(applyTextureEnvironment(env, GL.RGBA, fragment, [0.75, 0, 0, 1], primary),
        [1, 0.5, 0.5, 0.5], 'add clamps colour and multiplies alpha');

    env.mode = GL.BLEND;
    env.colour = [0, 0, 1, 1];
    assert.deepEqual(applyTextureEnvironment(env, GL.RGBA, fragment, texel, primary),
        [0, 0.5, 0.5, 0.25], 'blend mixes towards the environment colour by the texel');
});

test('GL_COMBINE evaluates the sources, operands and scale it was given', ()=>{
    const env = createTextureEnvironment();
    env.mode = GL.COMBINE;
    const fragment = [0.5, 0.5, 0.5, 1];
    const texel = [1, 0.5, 0, 0.5];
    const primary = [0.25, 0.25, 0.25, 1];

    // The defaults: MODULATE of TEXTURE and PREVIOUS.
    assert.deepEqual(applyTextureEnvironment(env, GL.RGBA, fragment, texel, primary),
        [0.5, 0.25, 0, 0.5]);

    env.combine.rgb = GL.INTERPOLATE;
    env.combine.sourceRgb = [GL.TEXTURE, GL.PRIMARY_COLOR, GL.CONSTANT];
    env.combine.operandRgb = [GL.SRC_COLOR, GL.SRC_COLOR, GL.SRC_ALPHA];
    env.colour = [0, 0, 0, 0.5];
    const interpolated = applyTextureEnvironment(env, GL.RGBA, fragment, texel, primary);
    assert.deepEqual(interpolated.slice(0, 3), [0.625, 0.375, 0.125],
        'texel * 0.5 + primary * 0.5');

    env.combine.rgb = GL.ADD_SIGNED;
    env.combine.sourceRgb = [GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT];
    env.combine.rgbScale = 2;
    const signed = applyTextureEnvironment(env, GL.RGBA, fragment, texel, primary);
    assert.deepEqual(signed.slice(0, 3), [1, 1, 0], '(texel + fragment - 0.5) * 2, clamped');

    env.combine.rgb = GL.DOT3_RGBA;
    env.combine.rgbScale = 1;
    const dot = applyTextureEnvironment(env, GL.RGBA, fragment, [1, 1, 1, 1], primary);
    assert.equal(dot[0], 0, '4 * (0.5 * 0 * 3) is zero');
    assert.equal(dot[3], 0, 'and DOT3_RGBA writes the same value to alpha');
});
