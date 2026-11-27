/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compatibility profile's oldest state (`context-legacy.js`): the
 * polygon stipple, pixel transfer and the pixel maps, the evaluators, and
 * 4.5's bounded getters of them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { bernstein } from './context-legacy.js';
import { LEGACY } from './legacy-state.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @returns {{ gl: any, bytes: Uint8Array, view: DataView }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    }, keepPrimitives: true });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return { gl, bytes, view: new DataView(bytes.buffer) };
}

/** A checkerboard: kept where x + y is even. */
const CHECKER = Array.from({ length: 32 }, (_, y)=>(y % 2 === 0 ? 0x55555555 : 0xaaaaaaaa));

/**
 * The pattern as a program hands it over: rows of four bytes, the first
 * pixel the high bit unless `lsbFirst`.
 *
 * @param {Uint8Array} bytes @param {number} at @param {readonly number[]} words
 * @param {boolean} [lsbFirst]
 */
function putPattern(bytes, at, words, lsbFirst = false){
    words.forEach((word, y)=>{
        for (let x = 0; x < 32; x++)
        {
            if (((word >>> x) & 1) !== 0)
            {
                bytes[at + y * 4 + (x >> 3)] |= lsbFirst ? 1 << (x & 7) : 0x80 >> (x & 7);
            }
        }
    });
}

/** @param {any} gl @returns {Uint8Array} the 8 by 8 framebuffer's red, bottom row first */
function reds(gl){
    const rgba = gl.glReadPixels(0, 0, 8, 8, GL.RGBA, GL.UNSIGNED_BYTE);
    return Uint8Array.from({ length: 64 }, (_, k)=>rgba[k * 4]);
}

test('a stipple read as a bitmap cuts filled polygons by window position, and no line', ()=>{
    const { gl, bytes } = fixture();
    putPattern(bytes, 0x100, CHECKER);
    gl.glPolygonStipple(0x100);
    gl.glEnable(GL.POLYGON_STIPPLE);
    gl.glColor3f(1, 1, 1);
    gl.glRectf(-1, -1, 1, 1);
    const drawn = reds(gl);
    for (let y = 0; y < 8; y++)
    {
        for (let x = 0; x < 8; x++)
        {
            assert.equal(drawn[y * 8 + x], (x + y) % 2 === 0 ? 255 : 0, `pixel ${x},${y}`);
        }
    }

    gl.glClear(GL.COLOR_BUFFER_BIT);
    gl.glBegin(GL.LINES);
    gl.glVertex2f(-1, 0.125);
    gl.glVertex2f(1, 0.125);
    gl.glEnd();
    assert.equal(reds(gl).slice(32, 40).filter(red=>red === 255).length, 8,
        'a line is not stippled by the polygon stipple');
});

test('the stipple round-trips through the pack state, refused by a size too small', ()=>{
    const { gl, bytes } = fixture();
    const solid = new Uint8Array(128).fill(0xff);
    gl.glGetPolygonStipple(0x400, null);
    assert.deepEqual(bytes.slice(0x400, 0x480), solid, 'every fragment drawn to start with');

    gl.glPixelStorei(GL.UNPACK_LSB_FIRST, 1);
    putPattern(bytes, 0x100, CHECKER, true);
    gl.glPolygonStipple(0x100);
    gl.glGetPolygonStipple(0x200, null);
    const expected = new Uint8Array(128);
    putPattern(expected, 0, CHECKER);
    assert.deepEqual(bytes.slice(0x200, 0x280), expected, 'packed with the high bit first');

    gl.glPixelStorei(GL.PACK_ALIGNMENT, 8);
    gl.glPixelStorei(GL.PACK_SKIP_ROWS, 1);
    gl.glGetPolygonStipple(0x600, 255);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, '8 + 31 * 8 + 4 bytes is past 255');
    assert.ok(bytes.slice(0x600, 0x700).every(b=>b === 0), 'nothing written');
    gl.glGetPolygonStipple(0x600, 260);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(bytes.slice(0x608, 0x60c), expected.slice(0, 4), 'row 0 a row in');
    assert.deepEqual(bytes.slice(0x610, 0x614), expected.slice(4, 8), 'eight bytes a row');
    assert.deepEqual(bytes.slice(0x60c, 0x610), new Uint8Array(4), 'the padding left alone');
});

test('the stipple is GL_POLYGON_STIPPLE_BIT\'s and a list keeps it as compiled', ()=>{
    const { gl, bytes } = fixture();
    putPattern(bytes, 0x100, CHECKER);
    gl.glPushAttrib(GL.POLYGON_STIPPLE_BIT);
    gl.glPolygonStipple(0x100);
    gl.glPopAttrib();
    gl.glGetPolygonStipple(0x200, null);
    assert.ok(bytes.slice(0x200, 0x280).every(b=>b === 0xff), 'the pop gave the solid back');

    const list = gl.glGenLists(1);
    gl.glNewList(list, GL.COMPILE);
    gl.glPolygonStipple(0x100);
    gl.glEndList();
    bytes.fill(0, 0x100, 0x180);
    gl.glCallList(list);
    gl.glGetPolygonStipple(0x300, null);
    const expected = new Uint8Array(128);
    putPattern(expected, 0, CHECKER);
    assert.deepEqual(bytes.slice(0x300, 0x380), expected, 'the bitmap read when compiled');
});

test('the stipple through pixel buffers: an offset into each, a range past one refused', ()=>{
    const { gl, bytes } = fixture();
    putPattern(bytes, 0x1000 + 16, CHECKER);
    const [unpack, pack] = gl.glGenBuffersARB(2);
    gl.glBindBufferARB(GL.PIXEL_UNPACK_BUFFER, unpack);
    gl.glBufferDataARB(GL.PIXEL_UNPACK_BUFFER, 144, 0x1000, GL.STATIC_DRAW);
    gl.glBindBufferARB(GL.PIXEL_PACK_BUFFER, pack);
    gl.glBufferDataARB(GL.PIXEL_PACK_BUFFER, 160, 0, GL.STATIC_DRAW);
    gl.glPolygonStipple(17);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, '17 + 128 is past 144');
    gl.glPolygonStipple(16);
    const store = gl.shareGroup.buffers.objects.get(pack);
    const version = store.version;
    gl.glGetPolygonStipple(32, null);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glGetPolygonStipple(33, null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, '33 + 128 is past 160');
    const expected = new Uint8Array(128);
    putPattern(expected, 0, CHECKER);
    assert.deepEqual(store.data.slice(32, 160), expected);
    assert.equal(store.version, version + 1,
        'the store is marked written for the copies elsewhere, once: the refusal wrote nothing');
});

test('a stippled draw on the device discards by the pattern its key carries', async()=>{
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    const renderer = createGpuRenderer({ backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }) });
    const bytes = new Uint8Array(0x1000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const gl = createGlContext({ memory, gpu: renderer });
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    putPattern(bytes, 0x100, CHECKER);
    gl.glPolygonStipple(0x100);
    gl.glEnable(GL.POLYGON_STIPPLE);
    gl.glRectf(-1, -1, 1, 1);
    gl.glBegin(GL.LINES);
    gl.glVertex2f(-1, 0);
    gl.glVertex2f(1, 0);
    gl.glEnd();
    renderer.present(gl);
    await renderer.settled();
    const codes = gpu.of('createShaderModule').map((/** @type {any} */ call)=>
        call.descriptor.code);
    const stippled = codes.filter((/** @type {string} */ code)=>/glStipple\[/.test(code));
    assert.equal(stippled.length, 1, 'the filled draw is cut, the line is not');
    assert.match(stippled[0], /array<u32, 32>\(0x55555555u, 0xaaaaaaaau, 0x55555555u/);
    assert.match(stippled[0], /fn fragmentMain\(input: VertexOut\)[^{]*\{\n {4}let glStippleX/);
});

test('glPixelTransfer keeps its state in GL_PIXEL_MODE_BIT and refuses another name', ()=>{
    const { gl } = fixture();
    gl.glPushAttrib(GL.PIXEL_MODE_BIT);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
    gl.glPixelTransferf(LEGACY.MAP_COLOR, 2);
    gl.glPixelTransferf(LEGACY.INDEX_SHIFT, 2.75);
    assert.deepEqual(gl.glGetFloatv(LEGACY.RED_SCALE), [0.5]);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.MAP_COLOR), [1]);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.INDEX_SHIFT), [2], 'truncated');
    gl.glPixelTransferf(GL.ZOOM_X, 1);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glPixelTransferf(0x80d2 /* POST_CONVOLUTION_RED_SCALE */, 1);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'the imaging subset\'s are not here');
    gl.glPopAttrib();
    assert.deepEqual(gl.glGetFloatv(LEGACY.RED_SCALE), [1]);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.MAP_COLOR), [0]);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.INDEX_SHIFT), [0]);
});

test('scale, bias and the colour maps apply to drawn, read and uploaded pixels', ()=>{
    const { gl, bytes, view } = fixture();
    gl.glColor3f(1, 1, 1);
    gl.glRectf(-1, -1, 1, 1);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
    gl.glPixelTransferf(LEGACY.GREEN_BIAS, -0.25);
    assert.deepEqual([...gl.glReadPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE)],
        [128, 191, 255, 255], 'read: red halved, green less a quarter');

    // R_TO_R of four entries: 1 to 0, 0.5 looked up at index 2 (rounded 1.5).
    [0.25, 0.5, 0.75, 1].forEach((value, k)=>view.setFloat32(0x100 + k * 4, value, true));
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_R_TO_R, 4, 0x100);
    gl.glPixelTransferf(LEGACY.MAP_COLOR, 1);
    assert.deepEqual([...gl.glReadPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE)],
        [191, 0, 0, 0], 'red mapped after its scale; the other maps hold a zero');

    gl.glPixelTransferf(LEGACY.MAP_COLOR, 0);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 1);
    gl.glPixelTransferf(LEGACY.GREEN_BIAS, 0);
    gl.glPixelTransferf(LEGACY.BLUE_SCALE, 0);
    bytes.set([10, 20, 30, 40], 0x200);
    gl.glRasterPos2f(-1, -1);
    gl.glDrawPixels(1, 1, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.of(10, 20, 30, 40));
    gl.glPixelTransferf(LEGACY.BLUE_SCALE, 1);
    assert.deepEqual([...gl.glReadPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE)],
        [10, 20, 0, 40], 'drawn: blue scaled to nothing');

    gl.glPixelTransferf(LEGACY.ALPHA_BIAS, 1);
    const [texture] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE, 0x200);
    gl.glPixelTransferf(LEGACY.ALPHA_BIAS, 0);
    const level = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual([...level], [10, 20, 30, 255], 'uploaded: alpha biased to one');
});

test('pixel maps: sizes, powers of two, clamped colours, and each getter\'s scaling', ()=>{
    const { gl, bytes, view } = fixture();
    assert.deepEqual(gl.glGetIntegerv(LEGACY.PIXEL_MAP_I_TO_I + LEGACY.PIXEL_MAP_SIZE), [1]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_PIXEL_MAP_TABLE), [256]);
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_A_TO_A, 0x400, 'f', null);
    assert.equal(view.getFloat32(0x400, true), 0, 'one entry of zero to start with');

    [3, 5, 7].forEach((value, k)=>view.setUint32(0x100 + k * 4, value, true));
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_I_TO_I, 3, 0x100, 'ui');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an index map takes a power of two');
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_R_TO_R, 3, 0x100, 'ui');
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'a colour map takes any size');
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_I_TO_I, 2, 0x100, 'ui');
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_I_TO_I, 512, 0x100, 'ui');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past GL_MAX_PIXEL_MAP_TABLE');
    gl.glPixelMapfv(GL.ZOOM_X, 1, 0x100, 'f');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.PIXEL_MAP_I_TO_I + LEGACY.PIXEL_MAP_SIZE), [2]);

    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_I_TO_I, 0x400, 'f', null);
    assert.deepEqual([view.getFloat32(0x400, true), view.getFloat32(0x404, true)], [3, 5],
        'an index map\'s unsigned integers are its entries');
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_R_TO_R, 0x400, 'f', null);
    assert.deepEqual([0, 1, 2].map(k=>view.getFloat32(0x400 + k * 4, true)),
        [3, 5, 7].map(value=>Math.fround(value / 0xffffffff)),
        'a colour map\'s are the fraction of the range');

    [-1, 0.5, 2, 0.25].forEach((value, k)=>view.setFloat32(0x100 + k * 4, value, true));
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_G_TO_G, 4, 0x100, 'f');
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_G_TO_G, 0x400, 'us', null);
    assert.deepEqual([0, 1, 2, 3].map(k=>view.getUint16(0x400 + k * 2, true)),
        [0, 32768, 65535, 16384], 'clamped to [0, 1], then scaled to the unsigned short');
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_G_TO_G, 0x400, 'ui', null);
    assert.equal(view.getUint32(0x404, true), 0x80000000);

    bytes.fill(0xee, 0x500, 0x520);
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_G_TO_G, 0x500, 'f', 15);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'four floats are 16 bytes');
    assert.ok(bytes.slice(0x500, 0x520).every(b=>b === 0xee), 'nothing written');
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_G_TO_G, 0x500, 'us', 8);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'four shorts fit eight bytes');
    gl.glGetPixelMapfv(GL.ZOOM_X, 0x500, 'f', null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});

test('pixel maps through pixel buffers, and a list keeps the entries it was given', ()=>{
    const { gl, view } = fixture();
    [0.5, 1].forEach((value, k)=>view.setFloat32(0x1000 + 8 + k * 4, value, true));
    const [unpack, pack] = gl.glGenBuffersARB(2);
    gl.glBindBufferARB(GL.PIXEL_UNPACK_BUFFER, unpack);
    gl.glBufferDataARB(GL.PIXEL_UNPACK_BUFFER, 16, 0x1000, GL.STATIC_DRAW);
    gl.glBindBufferARB(GL.PIXEL_PACK_BUFFER, pack);
    gl.glBufferDataARB(GL.PIXEL_PACK_BUFFER, 12, 0, GL.STATIC_DRAW);

    const list = gl.glGenLists(1);
    gl.glNewList(list, GL.COMPILE);
    gl.glPixelMapfv(LEGACY.PIXEL_MAP_B_TO_B, 2, 8, 'f');
    gl.glEndList();
    gl.glBindBufferARB(GL.PIXEL_UNPACK_BUFFER, 0);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.PIXEL_MAP_B_TO_B + LEGACY.PIXEL_MAP_SIZE), [1],
        'compiled, not run');
    gl.glCallList(list);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.PIXEL_MAP_B_TO_B + LEGACY.PIXEL_MAP_SIZE), [2]);

    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_B_TO_B, 4, 'f', null);
    const store = new DataView(gl.shareGroup.buffers.objects.get(pack).data.buffer);
    assert.deepEqual([store.getFloat32(4, true), store.getFloat32(8, true)], [0.5, 1]);
    gl.glGetPixelMapfv(LEGACY.PIXEL_MAP_B_TO_B, 5, 'f', null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, '5 + 8 is past 12');
});

test('Bernstein weights and their slopes', ()=>{
    const { weights, slopes } = bernstein(2, 0.25);
    assert.deepEqual(weights, [0.5625, 0.375, 0.0625]);
    assert.deepEqual(slopes, [-1.5, 1, 0.5]);
    assert.deepEqual(bernstein(0, 0.7), { weights: [1], slopes: [0] });
});

/**
 * A quadratic curve's control points for MAP1_VERTEX_3 and a colour map
 * from red to blue, both over [2, 4].
 *
 * @param {any} gl
 */
function curve(gl){
    gl.glMap1f(LEGACY.MAP1_VERTEX_3, 2, 4, 3, 3, [0, 0, 0, 1, 2, 0, 2, 0, 0]);
    gl.glMap1f(LEGACY.MAP1_COLOR_4, 2, 4, 4, 2, [1, 0, 0, 1, 0, 0, 1, 1]);
    gl.glEnable(LEGACY.MAP1_VERTEX_3);
    gl.glEnable(LEGACY.MAP1_COLOR_4);
}

test('glMap1 keeps its points, order and domain; glGetMap answers them in each type', ()=>{
    const { gl, view } = fixture();
    gl.glGetMapfv(LEGACY.MAP1_COLOR_4, LEGACY.COEFF, 'f', 0x100, null);
    assert.deepEqual([0, 1, 2, 3].map(k=>view.getFloat32(0x100 + k * 4, true)), [1, 1, 1, 1],
        'a map starts at order one with its target\'s initial point');
    gl.glGetMapfv(LEGACY.MAP2_TEXTURE_COORD_4, LEGACY.DOMAIN, 'd', 0x100, null);
    assert.deepEqual([0, 1, 2, 3].map(k=>view.getFloat64(0x100 + k * 8, true)), [0, 1, 0, 1]);

    gl.glMap1f(LEGACY.MAP1_VERTEX_3, 2, 4, 3, 3, [0, 0, 0, 1, 2.5, 0, 2, 0, 0]);
    gl.glGetMapfv(LEGACY.MAP1_VERTEX_3, LEGACY.COEFF, 'i', 0x100, null);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(k=>view.getInt32(0x100 + k * 4, true)),
        [0, 0, 0, 1, 3, 0, 2, 0, 0], 'rounded');
    gl.glGetMapfv(LEGACY.MAP1_VERTEX_3, LEGACY.ORDER, 'i', 0x100, null);
    assert.equal(view.getInt32(0x100, true), 3);
    gl.glGetMapfv(LEGACY.MAP1_VERTEX_3, LEGACY.DOMAIN, 'f', 0x100, null);
    assert.deepEqual([view.getFloat32(0x100, true), view.getFloat32(0x104, true)], [2, 4]);

    view.setUint32(0x200, 0xdeadbeef, true);
    gl.glGetMapfv(LEGACY.MAP1_VERTEX_3, LEGACY.COEFF, 'd', 0x200, 71);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'nine doubles are 72 bytes');
    assert.equal(view.getUint32(0x200, true), 0xdeadbeef, 'nothing written');
    gl.glGetMapfv(LEGACY.MAP1_VERTEX_3, LEGACY.COEFF, 'd', 0x200, 72);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glGetMapfv(LEGACY.MAP1_VERTEX_3, GL.ZOOM_X, 'f', 0x200, null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a query no map has');
    gl.glGetMapfv(GL.ZOOM_X, LEGACY.COEFF, 'f', 0x200, null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a target that is no map');
});

test('glMap1\'s and glMap2\'s refusals', ()=>{
    const { gl } = fixture();
    const point = [0, 0, 0];
    for (const [call, error] of /** @type {[() => void, number][]} */ ([
        [()=>gl.glMap1f(LEGACY.MAP1_VERTEX_3, 1, 1, 3, 1, point), GL.INVALID_VALUE],
        [()=>gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 1, 3, 0, point), GL.INVALID_VALUE],
        [()=>gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 1, 3, 9, point), GL.INVALID_VALUE],
        [()=>gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 1, 2, 1, point), GL.INVALID_VALUE],
        [()=>gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 1, 3, 1, null), GL.INVALID_VALUE],
        [()=>gl.glMap1f(GL.ZOOM_X, 0, 1, 3, 1, point), GL.INVALID_ENUM],
        [()=>gl.glMap1f(LEGACY.MAP2_VERTEX_3, 0, 1, 3, 1, point), GL.INVALID_ENUM],
        [()=>gl.glMap2f(LEGACY.MAP1_VERTEX_3, 0, 1, 3, 1, 0, 1, 3, 1, point), GL.INVALID_ENUM],
        [()=>gl.glMap2f(LEGACY.MAP2_VERTEX_3, 0, 1, 3, 1, 1, 1, 3, 1, point), GL.INVALID_VALUE],
        [()=>gl.glMap2f(LEGACY.MAP2_VERTEX_3, 0, 1, 3, 1, 0, 1, 1, 1, point), GL.INVALID_VALUE],
        [()=>gl.glMapGrid1f(0, 0, 1), GL.INVALID_VALUE],
        [()=>gl.glMapGrid2f(1, 0, 1, 0, 0, 1), GL.INVALID_VALUE],
        [()=>gl.glEvalMesh1(GL.FILL, 0, 1), GL.INVALID_ENUM],
        [()=>gl.glEvalMesh2(GL.POINTS, 0, 1, 0, 1), GL.INVALID_ENUM],
    ]))
    {
        call();
        assert.equal(gl.glGetError(), error, String(call));
    }
    gl.glActiveTextureARB(GL.TEXTURE0 + 1);
    gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 1, 3, 1, point);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'only while unit zero is active');
    gl.glBegin(GL.POINTS);
    gl.glEvalMesh1(GL.POINT, 0, 1);
    gl.glEnd();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a mesh is not made inside glBegin');
});

test('an evaluated vertex carries the evaluated colour, and the current colour stays', ()=>{
    const { gl } = fixture();
    curve(gl);
    gl.glColor4f(0, 1, 0, 1);
    gl.glBegin(GL.POINTS);
    gl.glEvalCoord1f(3);
    gl.glEnd();
    const [vertex] = gl.submittedPrimitives[0].vertices;
    assert.deepEqual(vertex.position, [1, 1, 0, 1], 'the curve at u = 0.5 of its domain');
    assert.deepEqual(vertex.color, [0.5, 0, 0.5, 1]);
    assert.deepEqual(gl.glGetFloatv(GL.CURRENT_COLOR), [0, 1, 0, 1]);

    gl.glDisable(LEGACY.MAP1_VERTEX_3);
    gl.glBegin(GL.POINTS);
    gl.glEvalCoord1f(3);
    gl.glEnd();
    assert.equal(gl.submittedPrimitives[1].vertices.length, 0, 'no vertex map, no vertex');
});

test('a mesh along the grid lands on the domain\'s ends exactly', ()=>{
    const { gl } = fixture();
    curve(gl);
    gl.glMapGrid1f(3, 2, 4);
    gl.glEvalMesh1(GL.LINE, 0, 3);
    const strip = gl.submittedPrimitives[0];
    assert.equal(strip.mode, GL.LINE_STRIP);
    strip.vertices.forEach((/** @type {any} */ v, /** @type {number} */ i)=>assert.ok(
        Math.abs(v.position[0] - 2 * i / 3) < 1e-12, 'x is 2t for this curve'));
    assert.deepEqual(strip.vertices[3].position, [2, 0, 0, 1]);
    gl.glEvalMesh1(GL.POINT, 1, 1);
    assert.equal(gl.submittedPrimitives[1].mode, GL.POINTS);
    gl.glBegin(GL.POINTS);
    gl.glEvalPoint1(3);
    gl.glEnd();
    assert.deepEqual(gl.submittedPrimitives[2].vertices[0].position, [2, 0, 0, 1]);

    // 0 + 3 * (0.7 - 0) / 3 is 0.6999999999999998 in doubles.
    gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 0.7, 3, 2, [0, 0, 0, 7, 0, 0]);
    gl.glMapGrid1f(3, 0, 0.7);
    gl.glBegin(GL.POINTS);
    gl.glEvalPoint1(3);
    gl.glEnd();
    assert.deepEqual(gl.submittedPrimitives[3].vertices[0].position, [7, 0, 0, 1],
        'the grid\'s last point is its domain\'s end, not a sum that falls short');
});

test('the texture coordinate map of the most coordinates is the one evaluated', ()=>{
    const { gl } = fixture();
    curve(gl);
    gl.glMap1f(LEGACY.MAP1_TEXTURE_COORD_1, 0, 1, 1, 1, [0.5]);
    gl.glMap1f(LEGACY.MAP1_TEXTURE_COORD_3, 0, 1, 3, 1, [0.25, 0.75, 1]);
    gl.glEnable(LEGACY.MAP1_TEXTURE_COORD_1);
    gl.glEnable(LEGACY.MAP1_TEXTURE_COORD_3);
    gl.glBegin(GL.POINTS);
    gl.glEvalCoord1f(3);
    gl.glEnd();
    assert.deepEqual(gl.submittedPrimitives[0].vertices[0].texCoord, [0.25, 0.75, 1, 1]);
    assert.deepEqual(gl.glGetFloatv(GL.CURRENT_TEXTURE_COORDS), [0, 0, 0, 1]);
});

test('GL_AUTO_NORMAL\'s normal of a four-component surface is the projected surface\'s', ()=>{
    const { gl } = fixture();
    // A bilinear net whose w varies: the projected surface bends.
    const net = [[0, 0, 0, 1], [0, 1, 1, 2], [1, 0, 2, 1], [2, 2, 0, 3]];
    gl.glMap2f(LEGACY.MAP2_VERTEX_4, 0, 1, 8, 2, 0, 1, 4, 2, net.flat());
    gl.glEnable(LEGACY.MAP2_VERTEX_4);
    gl.glEnable(GL.AUTO_NORMAL);
    gl.glBegin(GL.POINTS);
    gl.glEvalCoord2f(0.5, 0.5);
    gl.glEnd();
    /** @param {number} u @param {number} v @returns {number[]} */
    const projected = (u, v)=>{
        const p = [0, 1, 2, 3].map(c=>(1 - u) * (1 - v) * net[0][c] + (1 - u) * v * net[1][c]
            + u * (1 - v) * net[2][c] + u * v * net[3][c]);
        return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
    };
    const h = 1e-6;
    const du = projected(0.5 + h, 0.5).map((c, k)=>c - projected(0.5 - h, 0.5)[k]);
    const dv = projected(0.5, 0.5 + h).map((c, k)=>c - projected(0.5, 0.5 - h)[k]);
    const n = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2],
        du[0] * dv[1] - du[1] * dv[0]];
    const length = Math.hypot(...n);
    const normal = gl.submittedPrimitives[0].vertices[0].normal;
    n.forEach((c, k)=>assert.ok(Math.abs(c / length - normal[k]) < 1e-6,
        `${normal} against ${n.map(x=>x / length)}`));
});

/**
 * A flat patch: z = 0 over x, y in [0, 2], a homogeneous one with w = 2
 * when `w`.
 *
 * @param {any} gl @param {boolean} [w]
 */
function patch(gl, w = false){
    const target = w ? LEGACY.MAP2_VERTEX_4 : LEGACY.MAP2_VERTEX_3;
    const k = w ? 4 : 3;
    const points = [];
    for (let i = 0; i < 2; i++)
    {
        for (let j = 0; j < 2; j++)
        {
            points.push(...(w ? [i * 4, j * 4, 0, 2] : [i * 2, j * 2, 0]));
        }
    }
    gl.glMap2f(target, 0, 1, 2 * k, 2, 0, 1, k, 2, points);
    gl.glEnable(target);
}

test('a surface: its quad strips, and GL_AUTO_NORMAL\'s normal over GL_MAP2_NORMAL', ()=>{
    for (const homogeneous of [false, true])
    {
        const { gl } = fixture();
        patch(gl, homogeneous);
        gl.glMap2f(LEGACY.MAP2_NORMAL, 0, 1, 6, 2, 0, 1, 3, 2,
            [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
        gl.glEnable(LEGACY.MAP2_NORMAL);
        gl.glEnable(GL.AUTO_NORMAL);
        gl.glMapGrid2f(2, 0, 1, 2, 0, 1);
        gl.glEvalMesh2(GL.FILL, 0, 2, 0, 2);
        const strips = gl.submittedPrimitives;
        assert.equal(strips.length, 2, 'a quad strip a row');
        assert.equal(strips[0].mode, GL.QUAD_STRIP);
        assert.deepEqual(strips[0].vertices.slice(0, 2).map((/** @type {any} */ v)=>
            v.position.slice(0, 2).map((/** @type {number} */ c, /** @type {number} */ k)=>
                c / (v.position[3] ?? 1) + 0 * k)), [[0, 0], [0, 1]],
        'row j, then row j + 1');
        assert.deepEqual(strips[0].vertices[0].normal, [0, 0, 1],
            `${homogeneous ? 'w = 2' : 'xyz'}: du x dv up the z axis, unit length`);

        gl.glDisable(GL.AUTO_NORMAL);
        gl.glEvalMesh2(GL.POINT, 1, 1, 1, 1);
        assert.deepEqual(strips[2].vertices[0].normal, [1, 0, 0], 'the normal map\'s');
    }
});

test('a surface\'s lines run along each row and each column', ()=>{
    const { gl } = fixture();
    patch(gl);
    gl.glMapGrid2f(2, 0, 1, 1, 0, 1);
    gl.glEvalMesh2(GL.LINE, 0, 2, 0, 1);
    const strips = gl.submittedPrimitives;
    assert.deepEqual(strips.map((/** @type {any} */ s)=>s.vertices.length), [3, 3, 2, 2, 2],
        'two rows of three, three columns of two');
    assert.ok(strips.every((/** @type {any} */ s)=>s.mode === GL.LINE_STRIP));
});

test('a list runs an evaluation with the maps of its call, and keeps the points of its map',
    ()=>{
        const { gl } = fixture();
        curve(gl);
        const list = gl.glGenLists(1);
        gl.glNewList(list, GL.COMPILE_AND_EXECUTE);
        gl.glBegin(GL.POINTS);
        gl.glEvalCoord1f(4);
        gl.glEnd();
        gl.glEndList();
        assert.deepEqual(gl.submittedPrimitives[0].vertices[0].position, [2, 0, 0, 1],
            'run as it is compiled');
        gl.glMap1f(LEGACY.MAP1_VERTEX_3, 2, 4, 3, 2, [5, 5, 5, 6, 6, 6]);
        gl.glCallList(list);
        assert.equal(gl.submittedPrimitives[1].vertices.length, 1,
            'the evaluation is held, not the vertex it made');
        assert.deepEqual(gl.submittedPrimitives[1].vertices[0].position, [6, 6, 6, 1]);

        const maps = gl.glGenLists(1);
        const points = [7, 7, 7];
        gl.glNewList(maps, GL.COMPILE);
        gl.glMap1f(LEGACY.MAP1_VERTEX_3, 0, 1, 3, 1, points);
        gl.glEndList();
        points[0] = 0;
        gl.glCallList(maps);
        gl.glBegin(GL.POINTS);
        gl.glEvalCoord1f(0.5);
        gl.glEnd();
        assert.deepEqual(gl.submittedPrimitives[2].vertices[0].position, [7, 7, 7, 1]);
    });

test('GL_EVAL_BIT keeps the map enables and the grids', ()=>{
    const { gl } = fixture();
    gl.glPushAttrib(GL.EVAL_BIT);
    gl.glEnable(LEGACY.MAP2_COLOR_4);
    gl.glMapGrid2f(4, -1, 1, 5, 0, 2);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.MAP2_GRID_SEGMENTS), [4, 5]);
    gl.glPopAttrib();
    assert.equal(gl.glIsEnabled(LEGACY.MAP2_COLOR_4), GL.FALSE);
    assert.deepEqual(gl.glGetFloatv(LEGACY.MAP2_GRID_DOMAIN), [0, 1, 0, 1]);
    assert.deepEqual(gl.glGetIntegerv(LEGACY.MAP2_GRID_SEGMENTS), [1, 1]);
});

test('the imaging subset\'s getters refuse every target', ()=>{
    const { gl } = fixture();
    gl.glGetImagingTable();
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});
