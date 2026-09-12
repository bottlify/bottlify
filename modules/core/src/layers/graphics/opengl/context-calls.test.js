/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The contract of the entry points the `context-*.js` files install: what
 * they accept, what they refuse and with which error, and what a program
 * reads back afterwards. The expectations are the specification's error
 * tables and the observable semantics a conformance suite checks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** A guest address space the context reads its arrays and pixels from. */
function machine(){
    const bytes = new Uint8Array(0x10000);
    let next = 0x8000;
    return {
        bytes,
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
            allocate: (/** @type {number} */ size)=>{
                const at = next;
                next += (size + 16) & ~15;
                return at;
            },
        },
        /** @param {number} at @param {number[]} values */
        floats(at, values){
            const view = new DataView(bytes.buffer);
            values.forEach((value, i)=>view.setFloat32(at + i * 4, value, true));
        },
    };
}

/** @param {{ divergence?: (detail: string) => void }} [options] */
function drawing(options = {}){
    const box = machine();
    /** @type {any} */
    const context = createGlContext({ memory: box.memory, divergence: options.divergence });
    context.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    context.glMatrixMode(GL.PROJECTION);
    context.glLoadIdentity();
    context.glOrtho(0, 8, 0, 8, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    context.glLoadIdentity();
    return { context, box };
}

/** @param {any} frame @param {number} x @param {number} y @returns {number[]} */
const pixelAt = (frame, x, y)=>{
    const at = (y * frame.width + x) * 4;
    return [frame.bytes[at + 2], frame.bytes[at + 1], frame.bytes[at], frame.bytes[at + 3]];
};

// --- lighting ---

test('a light\'s position is fixed in eye space by the modelview current at the call', ()=>{
    const { context } = drawing();
    context.glTranslatef(1, 2, 3);
    context.glLightfv(GL.LIGHT0, GL.POSITION, [0, 0, 0, 1]);
    assert.deepEqual(context.glGetLightfv(GL.LIGHT0, GL.POSITION), [1, 2, 3, 1]);
    context.glLoadIdentity();
    assert.deepEqual(context.glGetLightfv(GL.LIGHT0, GL.POSITION), [1, 2, 3, 1],
        'and does not move when the matrix does');

    assert.deepEqual(context.glGetLightfv(GL.LIGHT0, GL.DIFFUSE), [1, 1, 1, 1]);
    assert.deepEqual(context.glGetLightfv(GL.LIGHT1, GL.DIFFUSE), [0, 0, 0, 1],
        'only the first light starts lit');
    assert.deepEqual(context.glGetLightfv(GL.LIGHT0, GL.SPOT_CUTOFF), [180]);

    context.glLightf(GL.LIGHT0, GL.SPOT_CUTOFF, 91);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'a cutoff past 90 that is not 180');
    context.glLightf(GL.LIGHT0, GL.SPOT_EXPONENT, -1);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glLightf(GL.LIGHT0 + 8, GL.SPOT_EXPONENT, 1);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'there are eight lights');
    context.glLightf(GL.LIGHT0, 0xdead, 1);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('materials take their face, and the shininess its range', ()=>{
    const { context } = drawing();
    assert.deepEqual(context.glGetMaterialfv(GL.FRONT, GL.AMBIENT), [0.2, 0.2, 0.2, 1]);
    assert.deepEqual(context.glGetMaterialfv(GL.BACK, GL.DIFFUSE), [0.8, 0.8, 0.8, 1]);
    context.glMaterialfv(GL.BACK, GL.DIFFUSE, [1, 0, 0, 1]);
    assert.deepEqual(context.glGetMaterialfv(GL.FRONT, GL.DIFFUSE), [0.8, 0.8, 0.8, 1]);
    assert.deepEqual(context.glGetMaterialfv(GL.BACK, GL.DIFFUSE), [1, 0, 0, 1]);
    context.glMaterialfv(GL.FRONT_AND_BACK, GL.AMBIENT_AND_DIFFUSE, [0, 1, 0, 1]);
    assert.deepEqual(context.glGetMaterialfv(GL.FRONT, GL.AMBIENT), [0, 1, 0, 1]);
    assert.deepEqual(context.glGetMaterialfv(GL.BACK, GL.DIFFUSE), [0, 1, 0, 1]);
    context.glMaterialf(GL.FRONT, GL.SHININESS, 129);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glGetMaterialfv(GL.FRONT_AND_BACK, GL.AMBIENT);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'a query names one face');
    context.glColorMaterial(GL.FRONT, GL.SHININESS);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('the fog and light model parameters are checked as the specification lists them', ()=>{
    const { context } = drawing();
    context.glFogf(GL.FOG_MODE, GL.LINEAR);
    assert.deepEqual(context.glGetIntegerv(GL.FOG_MODE), [GL.LINEAR]);
    context.glFogf(GL.FOG_MODE, 0xdead);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glFogf(GL.FOG_DENSITY, -1);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glFogfv(GL.FOG_COLOR, [2, -1, 0.5, 1]);
    assert.deepEqual(context.glGetFloatv(GL.FOG_COLOR), [1, 0, 0.5, 1], 'clamped');
    context.glLightModelf(GL.LIGHT_MODEL_COLOR_CONTROL, GL.SEPARATE_SPECULAR_COLOR);
    assert.deepEqual(context.glGetIntegerv(GL.LIGHT_MODEL_COLOR_CONTROL),
        [GL.SEPARATE_SPECULAR_COLOR]);
    context.glLightModelf(GL.LIGHT_MODEL_COLOR_CONTROL, 5);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

// --- texture parameters, environment, units ---

test('texture parameters refuse what is not a parameter or not a value of it', ()=>{
    const { context } = drawing();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER),
        [GL.LINEAR]);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'magnification has no mipmaps');
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, 0xdead);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, [1, 0.5, 0, 1]);
    assert.deepEqual(context.glGetTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR),
        [1, 0.5, 0, 1]);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, -1);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    // GL_TEXTURE_3D, which this implementation has no images for.
    context.glTexParameteri(0x806f, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'a target this has no textures for');
    assert.deepEqual(context.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_RESIDENT), [1]);
});

test('a level reads its shape back, and an empty level reads zero', ()=>{
    const { context } = drawing();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_WIDTH), [0]);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGB, 4, 2, 0, GL.RGB, GL.UNSIGNED_BYTE, null);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_WIDTH), [4]);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_HEIGHT), [2]);
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_ALPHA_SIZE),
        [0], 'an RGB texture has no alpha bits');
    assert.deepEqual(context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_RED_SIZE), [8]);
    assert.deepEqual(context.glGetTexLevelParameteriv(
        GL.TEXTURE_2D, 0, GL.TEXTURE_INTERNAL_FORMAT), [GL.RGB]);
    context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_COMPRESSED_IMAGE_SIZE);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'not a compressed level');
    context.glGetTexLevelParameteriv(GL.TEXTURE_2D, -1, GL.TEXTURE_WIDTH);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

test('a sub-image must fit the level it is written into', ()=>{
    const { context } = drawing();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4));
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'no level yet');
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 1, 1, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(16));
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'past the edge');
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 1, 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([9, 8, 7, 6]));
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const texels = context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual([...texels.subarray(12, 16)], [9, 8, 7, 6]);
    assert.deepEqual([...texels.subarray(0, 4)], [0, 0, 0, 0], 'a level with no data is zero');
});

test('glCopyTexImage2D takes the framebuffer, rows counted from the bottom', ()=>{
    const { context } = drawing();
    context.glClearColor(0, 0, 1, 1);
    context.glClear(GL.COLOR_BUFFER_BIT);
    context.glEnable(GL.SCISSOR_TEST);
    context.glScissor(0, 0, 8, 1);
    context.glClearColor(1, 0, 0, 1);
    context.glClear(GL.COLOR_BUFFER_BIT);
    context.glDisable(GL.SCISSOR_TEST);
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glCopyTexImage2D(GL.TEXTURE_2D, 0, GL.RGB, 0, 0, 2, 2, 0);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const texels = context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual([...texels.subarray(0, 4)], [255, 0, 0, 255], 'the bottom row is red');
    assert.deepEqual([...texels.subarray(8, 12)], [0, 0, 255, 255], 'the one above is blue');
});

test('the texture environment validates its combine parameters', ()=>{
    const { context } = drawing();
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE), [GL.MODULATE]);
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.SOURCE1_RGB), [GL.PREVIOUS]);
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.OPERAND2_RGB), [GL.SRC_ALPHA]);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.COMBINE);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.COMBINE_RGB, GL.DOT3_RGB);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.COMBINE_ALPHA, GL.DOT3_RGB);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'dot3 is not an alpha function');
    context.glTexEnvi(GL.TEXTURE_ENV, GL.RGB_SCALE, 3);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.OPERAND0_ALPHA, GL.SRC_COLOR);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'alpha operands are alpha');
    context.glTexEnvi(GL.TEXTURE_ENV, GL.SOURCE0_RGB, GL.PRIMARY_COLOR);
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.SOURCE0_RGB), [GL.PRIMARY_COLOR]);
    context.glTexEnvi(0xdead, GL.TEXTURE_ENV_MODE, GL.REPLACE);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('each texture unit keeps its own enables, bindings, environment and matrix', ()=>{
    const { context } = drawing();
    const [a, b] = context.glGenTextures(2);
    context.glBindTexture(GL.TEXTURE_2D, a);
    context.glEnable(GL.TEXTURE_2D);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE);
    context.glMatrixMode(GL.TEXTURE);
    context.glTranslatef(1, 0, 0);

    context.glActiveTextureARB(GL.TEXTURE1);
    assert.deepEqual(context.glGetIntegerv(GL.ACTIVE_TEXTURE), [GL.TEXTURE1]);
    assert.equal(context.glIsEnabled(GL.TEXTURE_2D), GL.FALSE);
    assert.deepEqual(context.glGetIntegerv(GL.TEXTURE_BINDING_2D), [0]);
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE), [GL.MODULATE]);
    assert.equal(context.glGetFloatv(GL.TEXTURE_MATRIX)[12], 0, 'its own matrix stack');
    context.glBindTexture(GL.TEXTURE_2D, b);
    context.glEnable(GL.TEXTURE_CUBE_MAP);

    context.glActiveTextureARB(GL.TEXTURE0);
    assert.deepEqual(context.glGetIntegerv(GL.TEXTURE_BINDING_2D), [a]);
    assert.equal(context.glIsEnabled(GL.TEXTURE_CUBE_MAP), GL.FALSE);
    assert.equal(context.glGetFloatv(GL.TEXTURE_MATRIX)[12], 1);
    context.glMatrixMode(GL.MODELVIEW);

    context.glActiveTextureARB(GL.TEXTURE0 + 4);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'four units');
    assert.deepEqual(context.glGetIntegerv(GL.MAX_TEXTURE_UNITS), [4]);

    // Deleting a texture unbinds it from every unit.
    context.glDeleteTextures([b]);
    context.glActiveTextureARB(GL.TEXTURE1);
    assert.deepEqual(context.glGetIntegerv(GL.TEXTURE_BINDING_2D), [0]);
});

test('glMultiTexCoord sets a unit\'s coordinates, and glTexCoord sets the first unit\'s', ()=>{
    const { context } = drawing();
    context.glMultiTexCoord4fARB(GL.TEXTURE1, 0.5, 0.25, 0, 1);
    context.glTexCoord2f(0.125, 0.75);
    context.glActiveTextureARB(GL.TEXTURE1);
    assert.deepEqual(context.glGetFloatv(GL.CURRENT_TEXTURE_COORDS), [0.5, 0.25, 0, 1]);
    context.glActiveTextureARB(GL.TEXTURE0);
    assert.deepEqual(context.glGetFloatv(GL.CURRENT_TEXTURE_COORDS), [0.125, 0.75, 0, 1]);
    context.glBegin(GL.POINTS);
    context.glVertex2f(1, 1);
    context.glEnd();
    assert.deepEqual(context.submittedPrimitives[0].vertices[0].texCoords[1], [0.5, 0.25, 0, 1]);
});

test('a cube map is one object with six faces and is complete only with all of them', ()=>{
    const { context } = drawing();
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_CUBE_MAP, name);
    context.glTexParameteri(GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X, 0, GL.RGBA, 1, 1, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, Uint8Array.from([255, 0, 0, 255]));
    assert.equal(context.isTextureComplete(GL.TEXTURE_CUBE_MAP), false, 'five faces missing');
    for (const face of [GL.TEXTURE_CUBE_MAP_NEGATIVE_X, GL.TEXTURE_CUBE_MAP_POSITIVE_Y,
        GL.TEXTURE_CUBE_MAP_NEGATIVE_Y, GL.TEXTURE_CUBE_MAP_POSITIVE_Z,
        GL.TEXTURE_CUBE_MAP_NEGATIVE_Z])
    {
        context.glTexImage2D(face, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            Uint8Array.from([0, 0, 255, 255]));
    }
    assert.equal(context.isTextureComplete(GL.TEXTURE_CUBE_MAP), true);
    context.glBindTexture(GL.TEXTURE_2D, name);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'a cube map is not a 2D texture');

    // Sampled by direction: +x is red, everything else blue.
    context.glEnable(GL.TEXTURE_CUBE_MAP);
    context.glColor3f(1, 1, 1);
    context.glBegin(GL.QUADS);
    context.glTexCoord3f(1, 0, 0);
    context.glVertex2f(0, 0);
    context.glTexCoord3f(1, 0, 0);
    context.glVertex2f(4, 0);
    context.glTexCoord3f(1, 0, 0);
    context.glVertex2f(4, 8);
    context.glTexCoord3f(1, 0, 0);
    context.glVertex2f(0, 8);
    context.glEnd();
    context.glBegin(GL.QUADS);
    context.glTexCoord3f(0, -1, 0);
    context.glVertex2f(4, 0);
    context.glTexCoord3f(0, -1, 0);
    context.glVertex2f(8, 0);
    context.glTexCoord3f(0, -1, 0);
    context.glVertex2f(8, 8);
    context.glTexCoord3f(0, -1, 0);
    context.glVertex2f(4, 8);
    context.glEnd();
    assert.deepEqual(pixelAt(context.framebuffer, 1, 1), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 6, 1), [0, 0, 255, 255]);
});

// --- vertex arrays and buffers ---

test('glDrawArrays draws the same pixels as the immediate-mode calls it stands for', ()=>{
    const immediate = drawing();
    immediate.context.glBegin(GL.TRIANGLES);
    immediate.context.glColor3f(1, 0, 0);
    immediate.context.glVertex2f(0, 0);
    immediate.context.glColor3f(0, 1, 0);
    immediate.context.glVertex2f(8, 0);
    immediate.context.glColor3f(0, 0, 1);
    immediate.context.glVertex2f(0, 8);
    immediate.context.glEnd();

    const { context, box } = drawing();
    box.floats(0x100, [0, 0, 8, 0, 0, 8]);
    box.bytes.set([255, 0, 0, 0, 255, 0, 0, 0, 255], 0x200);
    context.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    context.glColorPointer(3, GL.UNSIGNED_BYTE, 0, 0x200);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glEnableClientState(GL.COLOR_ARRAY);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.framebuffer.bytes, immediate.context.framebuffer.bytes);
    assert.deepEqual(context.submittedPrimitives[0].vertices[1].color, [0, 1, 0, 1],
        'an unsigned byte colour is normalised');
    assert.deepEqual(context.glGetIntegerv(GL.COLOR_ARRAY_SIZE), [3]);
    assert.deepEqual(context.glGetIntegerv(GL.COLOR_ARRAY_TYPE), [GL.UNSIGNED_BYTE]);
    assert.deepEqual(context.glGetPointerv(GL.COLOR_ARRAY_POINTER), [0x200]);
});

test('glDrawElements reads its indices, and a stride of zero means packed', ()=>{
    const { context, box } = drawing();
    // Interleaved x, y, and a pad, stride 12.
    box.floats(0x100, [0, 0, 99, 8, 0, 99, 0, 8, 99, 8, 8, 99]);
    box.bytes.set([3, 2, 1], 0x300);
    context.glVertexPointer(2, GL.FLOAT, 12, 0x100);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glColor3f(1, 1, 1);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_BYTE, 0x300);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    const vertices = context.submittedPrimitives[0].vertices;
    assert.deepEqual(vertices.map((/** @type {any} */ v)=>v.position.slice(0, 2)),
        [[8, 8], [0, 8], [8, 0]]);
    assert.deepEqual(pixelAt(context.framebuffer, 6, 1), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 1, 6), [0, 0, 0, 0]);

    context.glDrawElements(GL.TRIANGLES, 3, GL.FLOAT, 0x300);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'floats do not index');
    context.glDrawElements(0xdead, 3, GL.UNSIGNED_BYTE, 0x300);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glDrawArrays(GL.TRIANGLES, 0, -1);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glDrawRangeElementsEXT(GL.TRIANGLES, 5, 2, 3, GL.UNSIGNED_BYTE, 0x300);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'end before start');
    context.glVertexPointer(5, GL.FLOAT, 0, 0x100);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glVertexPointer(3, GL.UNSIGNED_BYTE, 0, 0x100);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'vertices are never bytes');
    context.glEnable(GL.VERTEX_ARRAY);
    assert.equal(context.glGetError(), GL.INVALID_ENUM, 'client state is not glEnable\'s');
});

test('glInterleavedArrays sets the pointers and enables the specification tabulates', ()=>{
    const { context } = drawing();
    context.glEnableClientState(GL.NORMAL_ARRAY);
    context.glInterleavedArrays(GL.T2F_C4UB_V3F, 0, 0x1000);
    assert.equal(context.glIsEnabled(GL.TEXTURE_COORD_ARRAY), GL.TRUE);
    assert.equal(context.glIsEnabled(GL.COLOR_ARRAY), GL.TRUE);
    assert.equal(context.glIsEnabled(GL.NORMAL_ARRAY), GL.FALSE, 'switched off by the format');
    assert.equal(context.glIsEnabled(GL.VERTEX_ARRAY), GL.TRUE);
    assert.deepEqual(context.glGetIntegerv(GL.COLOR_ARRAY_TYPE), [GL.UNSIGNED_BYTE]);
    assert.deepEqual(context.glGetIntegerv(GL.VERTEX_ARRAY_STRIDE), [24]);
    assert.deepEqual(context.glGetPointerv(GL.VERTEX_ARRAY_POINTER), [0x1000 + 12]);
    context.glInterleavedArrays(0xdead, 0, 0x1000);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('the client-active unit owns the texture coordinate array', ()=>{
    const { context } = drawing();
    context.glClientActiveTextureARB(GL.TEXTURE1);
    context.glTexCoordPointer(2, GL.FLOAT, 0, 0x2000);
    context.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    context.glClientActiveTextureARB(GL.TEXTURE0);
    assert.equal(context.glIsEnabled(GL.TEXTURE_COORD_ARRAY), GL.FALSE);
    assert.deepEqual(context.glGetIntegerv(GL.TEXTURE_COORD_ARRAY_SIZE), [4]);
    context.glClientActiveTextureARB(GL.TEXTURE1);
    assert.equal(context.glIsEnabled(GL.TEXTURE_COORD_ARRAY), GL.TRUE);
    assert.deepEqual(context.glGetIntegerv(GL.TEXTURE_COORD_ARRAY_SIZE), [2]);
    assert.deepEqual(context.glGetPointerv(GL.TEXTURE_COORD_ARRAY_POINTER), [0x2000]);
});

test('a buffer object is a store an array can point into', ()=>{
    const { context, box } = drawing();
    const [name] = context.glGenBuffersARB(1);
    assert.equal(context.glIsBufferARB(name), GL.FALSE, 'not a buffer until bound');
    context.glBufferDataARB(GL.ARRAY_BUFFER, 8, null, GL.STATIC_DRAW);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'nothing bound');
    context.glBindBufferARB(GL.ARRAY_BUFFER, name);
    assert.equal(context.glIsBufferARB(name), GL.TRUE);
    box.floats(0x100, [0, 0, 8, 0, 0, 8]);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 24, 0x100, GL.STATIC_DRAW);
    assert.deepEqual(context.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_SIZE), [24]);
    assert.deepEqual(context.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_USAGE),
        [GL.STATIC_DRAW]);
    context.glBufferSubDataARB(GL.ARRAY_BUFFER, 20, 8, 0x100);
    assert.equal(context.glGetError(), GL.INVALID_VALUE, 'past the end');

    // The pointer is an offset into the bound buffer, and stays so after
    // the buffer is unbound.
    context.glVertexPointer(2, GL.FLOAT, 0, 0);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    assert.deepEqual(context.glGetIntegerv(GL.VERTEX_ARRAY_BUFFER_BINDING), [name]);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glColor3f(1, 1, 1);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [255, 255, 255, 255]);

    // Mapping hands the program guest memory, and unmapping reads it back.
    context.glBindBufferARB(GL.ARRAY_BUFFER, name);
    const address = context.glMapBufferARB(GL.ARRAY_BUFFER, GL.WRITE_ONLY);
    assert.notEqual(address, 0);
    assert.deepEqual(context.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_MAPPED), [1]);
    context.glMapBufferARB(GL.ARRAY_BUFFER, GL.WRITE_ONLY);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'mapped twice');
    box.floats(address, [0, 0, 8, 8, 0, 8]);
    assert.equal(context.glUnmapBufferARB(GL.ARRAY_BUFFER), GL.TRUE);
    assert.deepEqual([...context.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 8, 8)],
        [...box.bytes.subarray(address + 8, address + 16)]);
    context.glDeleteBuffersARB([name]);
    assert.deepEqual(context.glGetIntegerv(GL.ARRAY_BUFFER_BINDING), [0]);
    assert.deepEqual(context.glGetIntegerv(GL.VERTEX_ARRAY_BUFFER_BINDING), [0]);
});

test('the compiled-array lock is refused twice and unlocked once', ()=>{
    const { context } = drawing();
    context.glUnlockArraysEXT();
    assert.equal(context.glGetError(), GL.INVALID_OPERATION);
    context.glLockArraysEXT(0, 0);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glLockArraysEXT(2, 5);
    assert.deepEqual(context.glGetIntegerv(GL.ARRAY_ELEMENT_LOCK_FIRST), [2]);
    context.glLockArraysEXT(0, 1);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION);
    context.glUnlockArraysEXT();
    assert.deepEqual(context.glGetIntegerv(GL.ARRAY_ELEMENT_LOCK_COUNT), [0]);
});

// --- display lists ---

test('a compiled glDrawArrays holds the vertices as they were, not the pointer', ()=>{
    const { context, box } = drawing();
    box.floats(0x100, [0, 0, 8, 0, 0, 8]);
    context.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glColor3f(1, 1, 1);
    const list = context.glGenLists(1);
    context.glNewList(list, GL.COMPILE);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    context.glEndList();
    assert.equal(context.submittedPrimitives.length, 0, 'compiled, not run');
    box.floats(0x100, [0, 0, 0, 0, 0, 0]);
    context.glCallList(list);
    assert.deepEqual(context.submittedPrimitives[0].vertices[1].position, [8, 0, 0, 1]);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [255, 255, 255, 255]);
});

test('glCallLists offsets each name by the list base', ()=>{
    const { context } = drawing();
    const first = context.glGenLists(3);
    for (let i = 0; i < 3; i++)
    {
        context.glNewList(first + i, GL.COMPILE);
        context.glColor3f(i / 2, 0, 0);
        context.glEndList();
    }
    context.glListBase(first);
    context.glCallLists(2, [2, 1]);
    assert.deepEqual(context.glGetFloatv(GL.CURRENT_COLOR), [0.5, 0, 0, 1], 'the last one wins');
});

// --- the attribute stacks ---

test('glPopAttrib restores only the groups that were pushed', ()=>{
    const { context } = drawing();
    context.glPushAttrib(GL.ENABLE_BIT);
    context.glEnable(GL.DEPTH_TEST);
    context.glColor3f(1, 0, 0);
    context.glDepthFunc(GL.GREATER);
    context.glPopAttrib();
    assert.equal(context.glIsEnabled(GL.DEPTH_TEST), GL.FALSE, 'the enable came back');
    assert.deepEqual(context.glGetFloatv(GL.CURRENT_COLOR), [1, 0, 0, 1], 'the colour did not');
    assert.deepEqual(context.glGetIntegerv(GL.DEPTH_FUNC), [GL.GREATER], 'nor the function');
    assert.deepEqual(context.glGetIntegerv(GL.ATTRIB_STACK_DEPTH), [0]);

    context.glPushAttrib(GL.LIGHTING_BIT | GL.TEXTURE_BIT);
    context.glLightfv(GL.LIGHT0, GL.DIFFUSE, [0, 1, 0, 1]);
    context.glActiveTextureARB(GL.TEXTURE1);
    context.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.DECAL);
    context.glEnable(GL.TEXTURE_2D);
    context.glPopAttrib();
    assert.deepEqual(context.glGetLightfv(GL.LIGHT0, GL.DIFFUSE), [1, 1, 1, 1]);
    assert.deepEqual(context.glGetIntegerv(GL.ACTIVE_TEXTURE), [GL.TEXTURE0]);
    context.glActiveTextureARB(GL.TEXTURE1);
    assert.deepEqual(context.glGetTexEnviv(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE), [GL.MODULATE]);
    assert.equal(context.glIsEnabled(GL.TEXTURE_2D), GL.FALSE);

    context.glPopAttrib();
    assert.equal(context.glGetError(), GL.STACK_UNDERFLOW);
    for (let i = 0; i < 16; i++)
    {
        context.glPushAttrib(GL.ALL_ATTRIB_BITS);
    }
    context.glPushAttrib(GL.ALL_ATTRIB_BITS);
    assert.equal(context.glGetError(), GL.STACK_OVERFLOW);
    assert.deepEqual(context.glGetIntegerv(GL.ATTRIB_STACK_DEPTH), [16]);
});

test('glPopClientAttrib restores the pixel store and the arrays', ()=>{
    const { context } = drawing();
    context.glPushClientAttrib(GL.CLIENT_PIXEL_STORE_BIT);
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    context.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    context.glPopClientAttrib();
    assert.deepEqual(context.glGetIntegerv(GL.UNPACK_ALIGNMENT), [4]);
    assert.deepEqual(context.glGetIntegerv(GL.VERTEX_ARRAY_SIZE), [2], 'arrays were not pushed');

    context.glPushClientAttrib(GL.CLIENT_VERTEX_ARRAY_BIT);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 0, 0x200);
    context.glPopClientAttrib();
    assert.equal(context.glIsEnabled(GL.VERTEX_ARRAY), GL.FALSE);
    assert.deepEqual(context.glGetIntegerv(GL.VERTEX_ARRAY_SIZE), [2]);
    assert.deepEqual(context.glGetPointerv(GL.VERTEX_ARRAY_POINTER), [0x100]);
});

// --- pixels and divergence ---

test('glReadPixels reads rows from the bottom and packs to the alignment', ()=>{
    const { context } = drawing();
    context.glClearColor(0, 0, 1, 1);
    context.glClear(GL.COLOR_BUFFER_BIT);
    context.glColor3f(1, 0, 0);
    context.glBegin(GL.POINTS);
    context.glVertex2f(0.5, 0.5);
    context.glEnd();
    const rgb = context.glReadPixels(0, 0, 3, 2, GL.RGB, GL.UNSIGNED_BYTE);
    assert.equal(rgb.length, 12 + 9, 'the first row is padded to four, the last is not');
    assert.deepEqual([...rgb.subarray(0, 6)], [255, 0, 0, 0, 0, 255], 'bottom-left first');
    context.glPixelStorei(GL.PACK_ALIGNMENT, 1);
    assert.equal(context.glReadPixels(0, 0, 3, 2, GL.RGB, GL.UNSIGNED_BYTE).length, 18);
    context.glReadPixels(0, 0, -1, 2, GL.RGB, GL.UNSIGNED_BYTE);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glReadPixels(0, 0, 1, 1, GL.STENCIL_INDEX, GL.UNSIGNED_BYTE);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION, 'no stencil buffer');
});

test('glDrawPixels draws at the raster position through the fragment operations', ()=>{
    const { context } = drawing();
    context.glRasterPos2f(2, 2);
    assert.deepEqual(context.glGetFloatv(GL.CURRENT_RASTER_POSITION).slice(0, 2), [2, 2]);
    context.glDrawPixels(2, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]));
    assert.deepEqual(pixelAt(context.framebuffer, 2, 5), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 3, 5), [0, 255, 0, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 2, 6), [0, 0, 0, 0], 'the row below untouched');

    context.glPixelZoom(2, 2);
    context.glRasterPos2f(4, 4);
    context.glDrawPixels(1, 1, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.from([0, 0, 255, 255]));
    assert.deepEqual(pixelAt(context.framebuffer, 5, 2), [0, 0, 255, 255], 'zoomed to a 2x2');

    context.glRasterPos3f(0, 0, 5);
    assert.deepEqual(context.glGetIntegerv(GL.CURRENT_RASTER_POSITION_VALID), [0],
        'a raster position past the far plane is invalid');
    context.glDrawPixels(1, 1, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.from([9, 9, 9, 255]));
    assert.deepEqual(pixelAt(context.framebuffer, 0, 7), [0, 0, 0, 0], 'and nothing is drawn');
});

test('a call that is accepted and not honoured reports a divergence, once', ()=>{
    /** @type {string[]} */
    const reported = [];
    const { context } = drawing({ divergence: detail=>reported.push(detail) });
    context.glEnable(GL.STENCIL_TEST);
    context.glEnable(GL.STENCIL_TEST);
    context.glAccum(0x0100, 1);
    context.glRenderMode(GL.SELECT);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(reported.length, 3);
    assert.match(reported[0], /stencil/);
    assert.match(reported[1], /accumulation/);
    assert.match(reported[2], /selection/);
});
