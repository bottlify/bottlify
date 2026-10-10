/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The byte-exact suite for the fixed-function pipeline: depth, blending,
 * the alpha test, texturing, fog, lighting, lines, points, clipping and the
 * polygon mode, each driven through the entry points a program uses and
 * checked against pixels this engine computed in arithmetic that is written
 * down. Nothing here touches a device, for the reason `raster.js` gives.
 *
 * The frames are 8x8: a larger one hides nothing and makes a failing diff
 * unreadable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { linesOf, polygonsOf } from './pipeline.js';

/**
 * A context attached to an 8x8 drawable, with a depth buffer unless told
 * otherwise, and a projection in which one unit is one pixel.
 *
 * @param {{ depth?: boolean }} [options]
 */
function drawing(options = {}){
    /** @type {any} */
    const context = createGlContext();
    context.attach({ width: 8, height: 8, doubleBuffered: false,
        depthBits: options.depth === false ? 0 : 24 });
    context.glMatrixMode(GL.PROJECTION);
    context.glLoadIdentity();
    context.glOrtho(0, 8, 0, 8, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    context.glLoadIdentity();
    context.glClearColor(0, 0, 0, 1);
    context.glClear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    return context;
}

/** @param {any} frame @param {number} x @param {number} y @returns {number[]} r, g, b, a */
const pixelAt = (frame, x, y)=>{
    const at = (y * frame.width + x) * 4;
    return [frame.bytes[at + 2], frame.bytes[at + 1], frame.bytes[at], frame.bytes[at + 3]];
};

/** @param {any} frame @returns {string} the red channel of every pixel, row by row */
const redMap = frame=>{
    const rows = [];
    for (let y = 0; y < frame.height; y++)
    {
        let row = '';
        for (let x = 0; x < frame.width; x++)
        {
            row += pixelAt(frame, x, y)[0] > 0 ? '#' : '.';
        }
        rows.push(row);
    }
    return rows.join('\n');
};

/**
 * A quad covering the whole frame at depth z, in one colour.
 *
 * @param {any} context @param {number} z @param {number[]} colour
 */
function fullQuad(context, z, colour){
    context.glColor4f(colour[0], colour[1], colour[2], colour[3] ?? 1);
    context.glBegin(GL.QUADS);
    context.glVertex3f(0, 0, z);
    context.glVertex3f(8, 0, z);
    context.glVertex3f(8, 8, z);
    context.glVertex3f(0, 8, z);
    context.glEnd();
}

// --- depth ---

test('the depth test keeps the nearer fragment and the depth mask keeps the buffer', ()=>{
    const context = drawing();
    context.glEnable(GL.DEPTH_TEST);

    // With GL_LESS a quad at z = 0.5 (window 0.25) beats the cleared 1.0,
    // and a later quad at z = -0.5 (window 0.75) does not.
    fullQuad(context, 0.5, [1, 0, 0]);
    fullQuad(context, -0.5, [0, 1, 0]);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [255, 0, 0, 255]);
    assert.equal(context.framebuffer.depth[3 * 8 + 3], 0.25);

    // GL_GEQUAL lets the farther one through.
    context.glDepthFunc(GL.GEQUAL);
    fullQuad(context, -0.5, [0, 1, 0]);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [0, 255, 0, 255]);
    assert.equal(context.framebuffer.depth[3 * 8 + 3], 0.75);

    // With the mask off the colour changes and the depth does not.
    context.glDepthMask(0);
    context.glDepthFunc(GL.ALWAYS);
    fullQuad(context, 0.9, [0, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [0, 0, 255, 255]);
    assert.equal(context.framebuffer.depth[3 * 8 + 3], 0.75);

    // glClear honours the mask too: the depth clear is refused.
    context.glClearDepth(0);
    context.glClear(GL.DEPTH_BUFFER_BIT);
    assert.equal(context.framebuffer.depth[3 * 8 + 3], 0.75);
    context.glDepthMask(1);
    context.glClear(GL.DEPTH_BUFFER_BIT);
    assert.equal(context.framebuffer.depth[3 * 8 + 3], 0);
    assert.equal(context.glGetError(), GL.NO_ERROR);
});

test('a format without a depth buffer draws in order whatever the test says', ()=>{
    const context = drawing({ depth: false });
    context.glEnable(GL.DEPTH_TEST);
    fullQuad(context, 0.5, [1, 0, 0]);
    fullQuad(context, -0.5, [0, 1, 0]);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [0, 255, 0, 255]);
    assert.equal(context.framebuffer.depth, null);
    assert.deepEqual(context.glGetIntegerv(GL.DEPTH_BITS), [0]);
});

test('the depth range maps window z and glReadPixels reads it back', ()=>{
    const context = drawing();
    context.glEnable(GL.DEPTH_TEST);
    context.glDepthRange(0.5, 1);
    fullQuad(context, 0, [1, 1, 1]);
    assert.equal(context.framebuffer.depth[0], 0.75);
    const read = context.glReadPixels(0, 0, 1, 1, GL.DEPTH_COMPONENT, GL.UNSIGNED_BYTE);
    assert.deepEqual([...read], [191]);
});

// --- blending, the alpha test, masks and logic ops ---

test('blending mixes by the factors named, on bytes, rounded once', ()=>{
    const context = drawing();
    fullQuad(context, 0, [0, 0, 1, 1]);
    context.glEnable(GL.BLEND);
    context.glBlendFunc(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
    fullQuad(context, 0, [1, 0, 0, 0.25]);
    // 255 * 0.25 = 63.75 -> 64 red; 255 * 0.75 = 191.25 -> 191 blue; and the
    // alpha is blended by itself: 64 * 0.25 + 255 * 0.75 = 207.
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [64, 0, 191, 207]);

    context.glBlendFunc(GL.ONE, GL.ONE);
    fullQuad(context, 0, [0, 1, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [64, 255, 191, 255], 'additive saturates');

    context.glBlendFunc(GL.DST_COLOR, GL.ZERO);
    fullQuad(context, 0, [0.5, 0.5, 0.5, 1]);
    // 64 * 128 / 255 = 32.1 -> 32; 255 * 128 / 255 = 128; 191 * 128 / 255 = 95.9 -> 96;
    // the alpha factor is the destination alpha, one, so alpha stays.
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [32, 128, 96, 255], 'modulate halves');
});

test('the alpha test drops fragments and the colour mask holds channels', ()=>{
    const context = drawing();
    context.glEnable(GL.ALPHA_TEST);
    context.glAlphaFunc(GL.GREATER, 0.5);
    fullQuad(context, 0, [1, 0, 0, 0.5]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [0, 0, 0, 255], '0.5 is not greater');
    fullQuad(context, 0, [1, 0, 0, 0.51]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [255, 0, 0, 130]);

    context.glDisable(GL.ALPHA_TEST);
    context.glColorMask(0, 1, 0, 0);
    fullQuad(context, 0, [0, 1, 1, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [255, 255, 0, 130],
        'only green was written');
});

test('a logic op combines bytes and takes precedence over blending', ()=>{
    const context = drawing();
    fullQuad(context, 0, [1, 0, 0, 1]);
    context.glEnable(GL.COLOR_LOGIC_OP);
    context.glEnable(GL.BLEND);
    context.glLogicOp(GL.XOR);
    fullQuad(context, 0, [1, 1, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [0, 255, 0, 0]);
    context.glLogicOp(GL.INVERT);
    fullQuad(context, 0, [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [255, 0, 255, 255]);
});

// --- lines and points ---

test('a line covers the pixel under each centre along its major axis, end excluded', ()=>{
    const context = drawing();
    context.glColor3f(1, 1, 1);
    context.glBegin(GL.LINES);
    context.glVertex2f(1, 6.5);
    context.glVertex2f(7, 6.5);
    context.glEnd();
    // Window y 6.5 is framebuffer row 1; x from 1 to 7 covers centres 1.5..6.5.
    assert.equal(redMap(context.framebuffer), [
        '........',
        '.######.',
        '........',
        '........',
        '........',
        '........',
        '........',
        '........',
    ].join('\n'));

    context.glClear(GL.COLOR_BUFFER_BIT);
    context.glBegin(GL.LINE_STRIP);
    context.glVertex2f(0, 0);
    context.glVertex2f(7, 7);
    context.glVertex2f(7, 0);
    context.glEnd();
    // The diagonal stops short of its end; the vertical at x = 7 lands in
    // column seven and stops short of row zero's centre.
    assert.equal(redMap(context.framebuffer), [
        '........',
        '......##',
        '.....#.#',
        '....#..#',
        '...#...#',
        '..#....#',
        '.#.....#',
        '#......#',
    ].join('\n'), 'a diagonal and a vertical, the strip continuing from the shared vertex');
});

test('a point is the square of its size around its centre', ()=>{
    const context = drawing();
    context.glColor3f(1, 1, 1);
    context.glBegin(GL.POINTS);
    context.glVertex2f(1.5, 6.5);
    context.glEnd();
    context.glPointSize(3);
    context.glBegin(GL.POINTS);
    context.glVertex2f(5.5, 2.5);
    context.glEnd();
    assert.equal(redMap(context.framebuffer), [
        '........',
        '.#......',
        '........',
        '........',
        '....###.',
        '....###.',
        '....###.',
        '........',
    ].join('\n'));
    context.glPointSize(0);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

// --- flat shading and the polygon mode ---

test('flat shading takes the provoking vertex: the last of a triangle, the first of a polygon',
    ()=>{
        const context = drawing();
        context.glShadeModel(GL.FLAT);
        context.glBegin(GL.TRIANGLES);
        context.glColor3f(1, 0, 0);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glColor3f(0, 1, 0);
        context.glVertex2f(0, 8);
        context.glEnd();
        assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [0, 255, 0, 255]);

        context.glBegin(GL.POLYGON);
        context.glColor3f(0, 0, 1);
        context.glVertex2f(0, 0);
        context.glColor3f(1, 1, 1);
        context.glVertex2f(8, 0);
        context.glVertex2f(0, 8);
        context.glEnd();
        assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [0, 0, 255, 255]);
    });

test('GL_LINE polygon mode draws the polygon\'s edges, not its triangulation', ()=>{
    const context = drawing();
    context.glColor3f(1, 1, 1);
    context.glPolygonMode(GL.FRONT_AND_BACK, GL.LINE);
    context.glBegin(GL.QUADS);
    context.glVertex2f(1, 1);
    context.glVertex2f(7, 1);
    context.glVertex2f(7, 7);
    context.glVertex2f(1, 7);
    context.glEnd();
    // A line at an integer coordinate lands in the pixel of that index, so
    // the right and top edges sit one past where a fill would stop -- the
    // familiar one-pixel offset of outlines drawn at integer coordinates.
    assert.equal(redMap(context.framebuffer), [
        '........',
        '.#######',
        '.#.....#',
        '.#.....#',
        '.#.....#',
        '.#.....#',
        '.#.....#',
        '.######.',
    ].join('\n'), 'four edges and no diagonal');
    assert.deepEqual(context.glGetIntegerv(GL.POLYGON_MODE), [GL.LINE, GL.LINE]);
});

test('culling and the front face agree on which way round a polygon is', ()=>{
    const context = drawing();
    context.glEnable(GL.CULL_FACE);
    context.glColor3f(1, 1, 1);
    // Counter-clockwise as GL sees it: front, kept.
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(0, 8);
    context.glEnd();
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [255, 255, 255, 255]);

    context.glClear(GL.COLOR_BUFFER_BIT);
    context.glFrontFace(GL.CW);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(0, 8);
    context.glEnd();
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [0, 0, 0, 255], 'now it is a back face');
});

// --- texturing ---

/**
 * A 2x2 texture, red-green over blue-white, bound and enabled.
 *
 * @param {any} context @param {number} filter
 */
function checkerTexture(context, filter){
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([
            255, 0, 0, 255, 0, 255, 0, 255,
            0, 0, 255, 255, 255, 255, 255, 255,
        ]));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, filter);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, filter);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
    context.glEnable(GL.TEXTURE_2D);
    return name;
}

/** @param {any} context */
function texturedQuad(context){
    context.glBegin(GL.QUADS);
    context.glTexCoord2f(0, 0);
    context.glVertex2f(0, 0);
    context.glTexCoord2f(1, 0);
    context.glVertex2f(8, 0);
    context.glTexCoord2f(1, 1);
    context.glVertex2f(8, 8);
    context.glTexCoord2f(0, 1);
    context.glVertex2f(0, 8);
    context.glEnd();
}

test('a nearest-filtered texture is mapped texel for texel, t upwards', ()=>{
    const context = drawing();
    checkerTexture(context, GL.NEAREST);
    texturedQuad(context);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const frame = context.framebuffer;
    // t = 0 is the bottom of the window, which is the last framebuffer row.
    assert.deepEqual(pixelAt(frame, 0, 7), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(frame, 7, 7), [0, 255, 0, 255]);
    assert.deepEqual(pixelAt(frame, 0, 0), [0, 0, 255, 255]);
    assert.deepEqual(pixelAt(frame, 7, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(frame, 3, 4), [255, 0, 0, 255], 'the seam is at the half');
    assert.deepEqual(pixelAt(frame, 4, 4), [0, 255, 0, 255]);
});

test('a linear-filtered texture blends across the seam and modulates the colour', ()=>{
    const context = drawing();
    checkerTexture(context, GL.LINEAR);
    context.glColor4f(0.5, 0.5, 0.5, 1);
    texturedQuad(context);
    const frame = context.framebuffer;
    // The pixel at (3, 7) has s = 7/16, so u = 0.875: 0.375 of the way from
    // red to green; halved by the colour. 255 * 0.625 * 0.5 = 79.7 -> 80.
    assert.deepEqual(pixelAt(frame, 3, 7), [80, 48, 0, 255]);
    assert.deepEqual(pixelAt(frame, 0, 7), [128, 0, 0, 255], 'the corner is clamped, then halved');
});

test('an incomplete texture draws as if texturing were off', ()=>{
    const context = drawing();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(16));
    context.glEnable(GL.TEXTURE_2D);
    // The default minification filter wants mipmaps this texture lacks.
    context.glColor3f(1, 1, 1);
    texturedQuad(context);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [255, 255, 255, 255]);
});

test('two texture units modulate in turn and the texture matrix applies per unit', ()=>{
    const context = drawing();
    checkerTexture(context, GL.NEAREST);
    context.glActiveTextureARB(GL.TEXTURE1);
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.LUMINANCE, 1, 1, 0, GL.LUMINANCE, GL.UNSIGNED_BYTE,
        Uint8Array.from([128]));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    context.glEnable(GL.TEXTURE_2D);
    assert.equal(context.glIsEnabled(GL.TEXTURE_2D), GL.TRUE);
    context.glActiveTextureARB(GL.TEXTURE0);
    texturedQuad(context);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [128, 0, 0, 255],
        'red from unit zero, halved by unit one');

    // Flipping unit zero's texture matrix swaps the rows.
    context.glMatrixMode(GL.TEXTURE);
    context.glLoadIdentity();
    context.glTranslatef(0, 1, 0);
    context.glScalef(1, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    texturedQuad(context);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [0, 0, 128, 255]);
});

test('a compressed texture samples its decoded blocks', ()=>{
    const context = drawing();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    const block = new Uint8Array(8);
    new DataView(block.buffer).setUint16(0, 0xf800, true);
    new DataView(block.buffer).setUint16(2, 0x001f, true);
    // Every texel index 1: pure blue.
    new DataView(block.buffer).setUint32(4, 0x55555555, true);
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4, 0,
        8, block);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    context.glEnable(GL.TEXTURE_2D);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_COMPRESSED),
        [1]);
    texturedQuad(context);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [0, 0, 255, 255]);
});

// --- fog and lighting ---

test('linear fog blends towards the fog colour by eye distance', ()=>{
    const context = drawing();
    context.glEnable(GL.FOG);
    context.glFogfv(GL.FOG_MODE, [GL.LINEAR]);
    context.glFogf(GL.FOG_START, 0);
    context.glFogf(GL.FOG_END, 1);
    context.glFogfv(GL.FOG_COLOR, [0, 0, 1, 1]);
    // The quad sits at z = -0.5, an eye distance of 0.5: half red, half blue.
    fullQuad(context, -0.5, [1, 0, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [128, 0, 128, 255]);
    assert.equal(context.glGetError(), GL.NO_ERROR);
});

test('a directional light shades by the normal, and the material sets the alpha', ()=>{
    const context = drawing();
    context.glEnable(GL.LIGHTING);
    context.glEnable(GL.LIGHT0);
    context.glLightfv(GL.LIGHT0, GL.POSITION, [0, 0, 1, 0]);
    context.glLightfv(GL.LIGHT0, GL.DIFFUSE, [1, 1, 1, 1]);
    context.glLightModelfv(GL.LIGHT_MODEL_AMBIENT, [0, 0, 0, 1]);
    context.glMaterialfv(GL.FRONT, GL.AMBIENT, [0, 0, 0, 1]);
    context.glMaterialfv(GL.FRONT, GL.DIFFUSE, [1, 0, 0, 0.5]);
    context.glNormal3f(0, 0, 1);
    fullQuad(context, 0, [0, 1, 0, 1]);
    // Facing the light: the full red diffuse, the material's alpha.
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [255, 0, 0, 128]);

    // Tilted 60 degrees: cos 60 = 0.5.
    context.glNormal3f(Math.sqrt(3) / 2, 0, 0.5);
    fullQuad(context, 0, [0, 1, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [128, 0, 0, 128]);

    // Colour material takes the diffuse from the vertex colour instead.
    context.glEnable(GL.COLOR_MATERIAL);
    context.glColorMaterial(GL.FRONT_AND_BACK, GL.DIFFUSE);
    context.glNormal3f(0, 0, 1);
    fullQuad(context, 0, [0, 1, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [0, 255, 0, 255]);
    assert.equal(context.glGetError(), GL.NO_ERROR);
});

// --- clipping ---

test('a triangle crossing the near plane is clipped rather than dropped', ()=>{
    const context = drawing();
    context.glColor3f(1, 1, 1);
    // z runs from 0 to -4 in object space, and the near plane is at z = 1
    // (the ortho's near of -1). Only the part between z = 1 and z = -1 shows.
    context.glBegin(GL.TRIANGLES);
    context.glVertex3f(0, 0, 0);
    context.glVertex3f(8, 0, 0);
    context.glVertex3f(0, 8, 4);
    context.glEnd();
    // The far part of the triangle -- window y above 2 -- is past z = 1, and
    // the hypotenuse is the other triangle's, as always.
    assert.equal(redMap(context.framebuffer), [
        '........',
        '........',
        '........',
        '........',
        '........',
        '........',
        '######..',
        '#######.',
    ].join('\n'));
});

test('a user clip plane cuts in eye space', ()=>{
    const context = drawing();
    context.glColor3f(1, 1, 1);
    // Keep x >= 4: the plane (1, 0, 0, -4).
    context.glClipPlane(GL.CLIP_PLANE0, [1, 0, 0, -4]);
    context.glEnable(GL.CLIP_PLANE0);
    fullQuad(context, 0, [1, 1, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [0, 0, 0, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 4, 3), [255, 255, 255, 255]);
    assert.deepEqual(context.glGetClipPlane(GL.CLIP_PLANE0), [1, 0, 0, -4]);
});

test('the scissor box confines a draw and a clear alike', ()=>{
    const context = drawing();
    context.glEnable(GL.SCISSOR_TEST);
    context.glScissor(2, 2, 4, 4);
    fullQuad(context, 0, [1, 1, 1]);
    assert.equal(redMap(context.framebuffer), [
        '........',
        '........',
        '..####..',
        '..####..',
        '..####..',
        '..####..',
        '........',
        '........',
    ].join('\n'));
    context.glClearColor(1, 0, 0, 1);
    context.glScissor(0, 0, 8, 1);
    context.glClear(GL.COLOR_BUFFER_BIT);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 6), [0, 0, 0, 255]);
});

// --- primitive assembly ---

test('the assembly tables name the provoking vertex the specification names', ()=>{
    assert.deepEqual(polygonsOf(GL.TRIANGLE_STRIP, 4), [
        { ring: [0, 1, 2], provoking: 2 },
        { ring: [2, 1, 3], provoking: 3 },
    ]);
    assert.deepEqual(polygonsOf(GL.TRIANGLE_FAN, 4), [
        { ring: [0, 1, 2], provoking: 2 },
        { ring: [0, 2, 3], provoking: 3 },
    ]);
    assert.deepEqual(polygonsOf(GL.QUAD_STRIP, 6), [
        { ring: [0, 1, 3, 2], provoking: 3 },
        { ring: [2, 3, 5, 4], provoking: 5 },
    ]);
    assert.deepEqual(polygonsOf(GL.POLYGON, 5), [{ ring: [0, 1, 2, 3, 4], provoking: 0 }]);
    assert.deepEqual(polygonsOf(GL.QUADS, 7).length, 1, 'a trailing partial quad is dropped');
    assert.deepEqual(linesOf(GL.LINE_LOOP, 3), [
        { from: 0, to: 1, provoking: 1 },
        { from: 1, to: 2, provoking: 2 },
        { from: 2, to: 0, provoking: 0 },
    ]);
    assert.deepEqual(linesOf(GL.LINES, 5).length, 2);
});

test('a compressed image compiled into a list draws the same blocks when the list plays', ()=>{
    // The list kept the decoded texels as the call's data, which its replay
    // then read as blocks.
    const context = drawing();
    const name = context.glGenTextures(1)[0];
    context.glBindTexture(GL.TEXTURE_2D, name);
    const block = new Uint8Array(8);
    new DataView(block.buffer).setUint16(0, 0xf800, true);
    new DataView(block.buffer).setUint16(2, 0x001f, true);
    new DataView(block.buffer).setUint32(4, 0x55555555, true);
    const list = context.glGenLists(1);
    context.glNewList(list, GL.COMPILE);
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4, 0,
        8, block);
    context.glEndList();
    context.glCallList(list);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    context.glEnable(GL.TEXTURE_2D);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    texturedQuad(context);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 3), [0, 0, 255, 255]);
});
