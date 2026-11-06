/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A context on a memory DC against what Wine's opengl32 tests find Windows
 * doing (test_bitmap_rendering, test_16bit_bitmap_rendering): the buffer
 * starts as the bitmap, drawing reaches the bitmap selected at glFinish and
 * not before, a bitmap selected later with nothing drawn is read in, and a
 * bitmap is met in the pixel format's words and the made-on bitmap's depth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL, PFD } from './constants.js';
import { PIXEL_FORMATS } from './pixelformat.js';
import { createWgl } from './wgl.js';

const MEMORY_DC = 0x20;

/**
 * A memory DC whose bitmaps are byte arrays, as GDI's surfaces are.
 *
 * @param {{ width: number, height: number, bitCount: number }[]} shapes
 */
function fixture(shapes){
    const bitmaps = shapes.map((shape, index)=>{
        const pitch = ((shape.width * shape.bitCount + 31) >>> 5) * 4;
        // Guard bytes past the bits, which nothing may write.
        const bytes = new Uint8Array(pitch * shape.height + 64);
        bytes.fill(0xee, pitch * shape.height);
        return { handle: 0x100 + index, surface: { ...shape, pitch, topDown: true, bytes,
            offset: 0 } };
    });
    let selected = bitmaps[0];
    const wgl = createWgl({
        gdi: {
            describeDrawable: hdc=>(hdc === MEMORY_DC ? { key: 'dc:0x20',
                width: selected.surface.width, height: selected.surface.height, memory: true }
                : null),
            bitmapSurface: hdc=>(hdc === MEMORY_DC
                ? { bitmap: selected.handle, surface: selected.surface } : null),
        },
        currentThread: ()=>1,
        extensions: { WGL_ARB_extensions_string: ['wglGetExtensionsStringARB'] },
    });
    return {
        wgl, bitmaps,
        /** @param {number} index */
        select(index){
            selected = bitmaps[index];
        },
    };
}

/** @param {number} colorBits @returns {number} a bitmap format of that depth, with alpha at 32 */
const bitmapFormat = colorBits=>1 + PIXEL_FORMATS.findIndex(format=>
    (format.dwFlags & PFD.DRAW_TO_BITMAP) !== 0 && format.cColorBits === colorBits);

/** @param {any} gl @param {number} r @param {number} g @param {number} b */
function clear(gl, r, g, b){
    gl.glClearColor(r / 255, g / 255, b / 255, 1);
    gl.glClear(GL.COLOR_BUFFER_BIT);
}

/** @param {Uint8Array} bytes @param {number} at @returns {number} */
const word = (bytes, at)=>(bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
    | (bytes[at + 3] << 24)) >>> 0;

test('a context on a bitmap draws there at glFinish, into the bitmap selected then', ()=>{
    const f = fixture([{ width: 4, height: 4, bitCount: 32 }, { width: 12, height: 12,
        bitCount: 32 }]);
    f.bitmaps[0].surface.bytes.fill(0xcd);
    f.bitmaps[1].surface.bytes.fill(0xdc);
    assert.ok(f.wgl.SetPixelFormat(MEMORY_DC, bitmapFormat(32)));
    const gl = f.wgl.wglCreateContext(MEMORY_DC);
    assert.ok(f.wgl.wglMakeCurrent(MEMORY_DC, gl));
    assert.equal(f.wgl.wglGetProcAddress('wglGetExtensionsStringARB'), null,
        'the generic renderer has no WGL extensions');
    f.wgl.meetBitmap(gl);
    assert.deepEqual([...gl.glReadPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE)].slice(0, 3),
        [0xcd, 0xcd, 0xcd], 'the buffer starts as the bitmap');

    clear(gl, 0x22, 0x33, 0x44);
    assert.equal(word(f.bitmaps[0].surface.bytes, 0) & 0xffffff, 0xcdcdcd, 'not yet');
    f.wgl.meetBitmap(gl);
    assert.equal(word(f.bitmaps[0].surface.bytes, 0) & 0xffffff, 0x223344, 'at glFinish');

    f.select(1);
    f.wgl.meetBitmap(gl);
    assert.deepEqual([...gl.glReadPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE)].slice(0, 3),
        [0xdc, 0xdc, 0xdc], 'nothing drawn: the bitmap selected since is read in');
    clear(gl, 0x44, 0x33, 0x22);
    f.wgl.meetBitmap(gl);
    assert.equal(word(f.bitmaps[1].surface.bytes, 0) & 0xffffff, 0x443322,
        'what is drawn goes to the bitmap selected now');
    assert.equal(word(f.bitmaps[0].surface.bytes, 0) & 0xffffff, 0x223344);
    f.wgl.wglMakeCurrent(MEMORY_DC, gl);
    assert.deepEqual([gl.framebuffer.width, gl.framebuffer.height], [4, 4],
        'made current again over the larger bitmap, it keeps the size it was made at');
    f.wgl.wglMakeCurrent(MEMORY_DC, null);
    f.wgl.wglDeleteContext(gl);
});

test('a bitmap is met in the format\'s words, its values the depth the context was made in', ()=>{
    // A 32-bit context over a sixteen-bit DIB writes 32-bit pixels into it
    // (test_bitmap_rendering's DIB half), and one made over that DIB draws
    // in five bits a channel.
    const f = fixture([{ width: 4, height: 4, bitCount: 32 }, { width: 12, height: 12,
        bitCount: 16 }, { width: 4, height: 4, bitCount: 16 }]);
    assert.ok(f.wgl.SetPixelFormat(MEMORY_DC, bitmapFormat(32)));
    const wide = f.wgl.wglCreateContext(MEMORY_DC);
    f.select(1);
    const narrow = f.wgl.wglCreateContext(MEMORY_DC);
    f.wgl.wglMakeCurrent(MEMORY_DC, wide);
    clear(wide, 0x66, 0x77, 0x88);
    f.wgl.meetBitmap(wide);
    assert.equal(word(f.bitmaps[1].surface.bytes, 0) & 0xffffff, 0x667788);
    assert.equal(word(f.bitmaps[1].surface.bytes, 4) & 0xffffff, 0x667788, 'a word a pixel');

    f.select(0);
    f.wgl.wglMakeCurrent(MEMORY_DC, narrow);
    clear(narrow, 0x88, 0x77, 0x66);
    f.wgl.meetBitmap(narrow);
    assert.equal(word(f.bitmaps[0].surface.bytes, 0), 0x45cc, 'five bits a channel, in a word');
    // Four 32-bit words a row over a DIB of eight bytes a row: half of it
    // falls past the bits, and is not written.
    f.select(2);
    f.wgl.wglMakeCurrent(MEMORY_DC, wide);
    clear(wide, 0x11, 0x22, 0x33);
    f.wgl.meetBitmap(wide);
    const small = f.bitmaps[2].surface.bytes;
    assert.equal(word(small, 0) & 0xffffff, 0x112233);
    assert.ok(small.subarray(4 * 8).every(byte=>byte === 0xee),
        'and nothing past a bitmap\'s bits');
    f.wgl.wglMakeCurrent(MEMORY_DC, null);
    f.wgl.wglDeleteContext(wide);
    f.wgl.wglDeleteContext(narrow);
});

test('a sixteen-bit format meets a sixteen-bit DIB pixel for pixel', ()=>{
    // test_16bit_bitmap_rendering: white is 0x7fff in every pixel.
    const f = fixture([{ width: 4, height: 4, bitCount: 16 }]);
    const format = bitmapFormat(16);
    assert.equal(PIXEL_FORMATS[format - 1].cRedShift, 10);
    assert.ok(f.wgl.SetPixelFormat(MEMORY_DC, format));
    const gl = f.wgl.wglCreateContext(MEMORY_DC);
    f.wgl.wglMakeCurrent(MEMORY_DC, gl);
    clear(gl, 0xff, 0xff, 0xff);
    f.wgl.meetBitmap(gl);
    const bytes = f.bitmaps[0].surface.bytes;
    assert.deepEqual([bytes[0] | (bytes[1] << 8), bytes[2] | (bytes[3] << 8)], [0x7fff, 0x7fff]);
    f.wgl.wglMakeCurrent(MEMORY_DC, null);
    f.wgl.wglDeleteContext(gl);
});
