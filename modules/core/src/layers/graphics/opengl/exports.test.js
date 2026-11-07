/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ABI of OPENGL32.dll.
 *
 * Most of what is checked here is arithmetic about the stack, because that is
 * where this library can go wrong without saying anything: these are stdcall
 * entry points, the callee cleans up, and a count that is one word out leaves
 * the caller returning to an address it never pushed. Nothing about the picture
 * says which call did it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ARGUMENT_WORDS, byteRunNames, byteRunWidth, createOpengl, floatArguments,
} from './exports.js';
import { GL, PFD, WGL } from './constants.js';
import { registryArguments } from './extensions.js';
import { PIXELFORMATDESCRIPTOR, PIXEL_FORMATS, encodePixelFormat } from './pixelformat.js';

/** The dword a guest pushes for a GLfloat. @param {number} value */
function floatBits(value){
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
}

/** The two dwords a guest pushes for a GLdouble, low word first. @param {number} value */
function doubleBits(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
}

/** A guest address space, and somewhere to allocate in it. */
function machine(){
    const bytes = new Uint8Array(0x40000);
    let next = 0x100;
    return {
        bytes,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            bytes.set(value, at),
        scratch: {
            allocate: (/** @type {number} */ size)=>{
                const at = next;
                next += size + 16 & ~15;
                return at;
            },
        },
    };
}

/**
 * The export table as these tests call it: with no device behind it no call
 * waits, a swap included, so every handler answers a number.
 *
 * @typedef {Record<string, { argBytes: number, handler: (args: number[]) => number }>} Table
 */

/**
 * A library over a 4x4 screen, with whatever it presented recorded, and the
 * window and screen each frame was presented for.
 *
 * @param {{ present?: boolean, raster?: boolean,
 *     describeDrawable?: (hdc: number) => any }} [options]
 */
function library(options = {}){
    const box = machine();
    /** @type {any[]} */
    const presented = [];
    /** @type {[number | undefined, boolean | undefined][]} */
    const presentedFor = [];
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        present: options.present === false ? undefined
            : (/** @type {any} */ s, /** @type {number} */ window = 0, exclusive = false)=>{
                presented.push(s);
                presentedFor.push([window, exclusive]);
            },
        raster: options.raster,
        describeDrawable: options.describeDrawable,
    });
    return { box, opengl, presented, presentedFor, table: /** @type {Table} */ (opengl.table) };
}

test('no export is declared twice, and every one takes a whole number of words', ()=>{
    // A name in two groups takes whichever count is read last, silently. That
    // is the one mistake this table can make that no other test would see.
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (const [words, names] of Object.entries(ARGUMENT_WORDS))
    {
        for (const name of names)
        {
            assert.equal(seen.get(name), undefined,
                `${name} is declared in two groups (${seen.get(name)} and ${words})`);
            seen.set(name, Number(words));
        }
    }
    assert.ok(seen.size > 300, `only ${seen.size} exports declared`);

    const { table } = library();
    for (const [name, entry] of Object.entries(table))
    {
        assert.equal(entry.argBytes % 4, 0, `${name} takes a fraction of a word`);
        assert.equal(typeof entry.handler, 'function', `${name} has no handler`);
    }
});

test('a double-precision entry point takes twice the stack of its float twin', ()=>{
    // The whole reason the sizes are written out rather than derived: a
    // GLdouble is two words, and every derivation from a JavaScript parameter
    // list says one.
    const { table } = library();

    assert.equal(table.glVertex3f.argBytes, 12);
    assert.equal(table.glVertex3d.argBytes, 24);
    assert.equal(table.glTranslatef.argBytes, 12);
    assert.equal(table.glTranslated.argBytes, 24);
    assert.equal(table.glClearDepth.argBytes, 8, 'its one argument is a GLclampd');
    assert.equal(table.glDepthRange.argBytes, 16, 'and its two are as well, so four words');
    assert.equal(table.glOrtho.argBytes, 48);
    assert.equal(table.glMap2d.argBytes, 56, 'the largest of them');
});

test('an argument list is the C one, not the implementation\'s', ()=>{
    const { table } = library();

    // glGenTextures answers with an array here and takes an out-pointer there.
    assert.equal(table.glGenTextures.argBytes, 8);
    // The descriptor SetPixelFormat never reads is still on the stack.
    assert.equal(table.wglSetPixelFormat.argBytes, 12);
    // Nine arguments, the last of them the pixels.
    assert.equal(table.glTexImage2D.argBytes, 36);
    assert.equal(table.glReadPixels.argBytes, 28);
    assert.equal(table.wglUseFontOutlinesA.argBytes, 32);
});

test('a float argument is the bits of one, not the word', ()=>{
    // A handler that takes the dword as it stands reads 1.0 as 1065353216 and
    // clamps it to white. Every colour in the program then comes out saturated,
    // which looks like a blending fault and is a marshalling one.
    const { table, box } = library();
    startDrawing(table);

    table.glClearColor.handler(
        [floatBits(0.25), floatBits(0.5), floatBits(0.75), floatBits(1)]);
    table.glClear.handler([GL.COLOR_BUFFER_BIT]);

    const out = 0x2000;
    table.glGetFloatv.handler([GL.COLOR_CLEAR_VALUE, out]);
    const read = new DataView(box.bytes.buffer, out, 16);
    assert.equal(read.getFloat32(0, true), 0.25);
    assert.equal(read.getFloat32(4, true), 0.5);
    assert.equal(read.getFloat32(8, true), 0.75);
    assert.equal(read.getFloat32(12, true), 1);
});

test('a GLboolean argument is its low byte, not the word', ()=>{
    // A compiler answers a comparison in a byte register and pushes the whole
    // register, so FALSE arrives as 0x100 with whatever the upper bytes held.
    // Read as a word that is TRUE, and a mask meant to keep a channel closed
    // writes into it: a light pass meant for the alpha channel lands in red.
    const { table, box } = library();
    startDrawing(table);

    table.glColorMask.handler([0x100, 0x1, 0x200, 0x101]);
    const out = 0x2000;
    table.glGetIntegerv.handler([GL.COLOR_WRITEMASK, out]);
    const mask = new DataView(box.bytes.buffer, out, 16);
    assert.deepEqual([0, 1, 2, 3].map(k=>mask.getInt32(k * 4, true)), [0, 1, 0, 1]);

    table.glDepthMask.handler([0x100]);
    table.glGetIntegerv.handler([GL.DEPTH_WRITEMASK, out]);
    assert.equal(mask.getInt32(0, true), 0, 'and the depth mask reads the same byte');
});

test('a double argument is the bits of two words, low word first', ()=>{
    const { table, box } = library();
    startDrawing(table);

    const [low, high] = doubleBits(0.25);
    table.glClearDepth.handler([low, high]);

    const out = 0x2000;
    table.glGetFloatv.handler([GL.DEPTH_CLEAR_VALUE, out]);
    assert.equal(new DataView(box.bytes.buffer, out, 4).getFloat32(0, true), 0.25);
});

test('a query writes the type it was asked for, and leaves an unknown one alone', ()=>{
    const { table, box } = library();
    startDrawing(table);

    // GL_DITHER is the one capability that starts on, so a booleanv that reads
    // as zero here is not a default that happens to be right.
    const out = 0x2000;
    box.bytes[out] = 0xcc;
    table.glGetBooleanv.handler([GL.DITHER, out]);
    assert.equal(box.bytes[out], 1, 'one byte per boolean, not one word');

    box.bytes[out] = 0xcc;
    table.glGetIntegerv.handler([0x1234, out]);
    assert.equal(box.bytes[out], 0xcc, 'an unknown query leaves the buffer untouched');
    assert.equal(table.glGetError.handler([]), GL.INVALID_ENUM);
});

test('glGetString answers with a pointer into guest memory', ()=>{
    // A program stores what it was given and parses it later, so the string has
    // to be somewhere the guest can read for as long as the context lives --
    // and asking twice has to give the same pointer rather than leak one.
    const { table, box } = library();
    startDrawing(table);

    const address = table.glGetString.handler([GL.VENDOR]);
    assert.notEqual(address, 0);
    assert.equal(table.glGetString.handler([GL.VENDOR]), address);

    const end = box.bytes.indexOf(0, address);
    const text = new TextDecoder().decode(box.bytes.subarray(address, end));
    assert.equal(text, 'Bottlify Project');
});

test('an unimplemented export cleans its stack, answers zero, and is counted', ()=>{
    const { table, opengl } = library();
    startDrawing(table);

    // The evaluators are the one part of GL 1.1 nothing here implements.
    assert.equal(table.glMap1f.argBytes, 24);
    assert.equal(table.glMap1f.handler([0, floatBits(0), floatBits(1), 3, 4, 0]), 0);
    table.glMap1f.handler([0, floatBits(0), floatBits(1), 3, 4, 0]);
    table.glEvalCoord1f.handler([floatBits(0.5)]);

    assert.deepEqual(opengl.diagnostics().unimplemented, { glMap1f: 2, glEvalCoord1f: 1 },
        'which entry points a program reached for is what a run that drew nothing has to say');
});

test('wglGetProcAddress refuses a core entry point', ()=>{
    // A program uses a non-null answer as proof that an extension is present.
    // This build advertises none, so the honest answer to everything is null.
    const { table } = library();
    startDrawing(table);

    assert.equal(table.wglGetProcAddress.handler([0x1000]), 0);
});

test('wglGetProcAddress reads a name that ends just short of the end of its memory', ()=>{
    // Past the end lies another allocation, or nothing: memory refuses a read
    // that runs into it, as the memory layer refuses one past a region's end.
    const box = machine();
    const end = 0x2000;
    const opengl = createOpengl({
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
            assert.ok(at >= end || at + length <= end,
                `read of ${length} bytes at 0x${at.toString(16)} runs past the end of memory`);
            return box.readMemory(at, length);
        },
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        exportAddress: ()=>0x7000_0000,
    });
    const table = /** @type {Table} */ (opengl.table);
    startDrawing(table);
    const name = new TextEncoder().encode('glActiveTextureARB\0');
    const at = end - 8 - name.length;
    box.writeMemory(at, name);
    assert.equal(table.wglGetProcAddress.handler([at]), 0x7000_0000);
});

test('the whole path: choose a format, make a context, clear, swap', ()=>{
    const { table, box, presented } = library();

    // ChoosePixelFormat reads a descriptor out of guest memory.
    const request = 0x1000;
    box.writeMemory(request, encodePixelFormat(/** @type {any} */ ({
        nSize: PIXELFORMATDESCRIPTOR.SIZE,
        nVersion: 1,
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER,
        iPixelType: PFD.TYPE_RGBA,
        cColorBits: 32,
        cDepthBits: 16,
        cStencilBits: 0,
        cAlphaBits: 0,
        cAccumBits: 0,
        cAuxBuffers: 0,
        iLayerType: PFD.MAIN_PLANE,
    })));

    const hdc = 0x900d;
    const format = table.wglChoosePixelFormat.handler([hdc, request]);
    assert.ok(format > 0, 'a format was offered');
    assert.equal(table.wglSetPixelFormat.handler([hdc, format, request]), 1);
    assert.equal(table.wglGetPixelFormat.handler([hdc]), format);

    // A context cannot be made before a format is set, and this one can.
    const context = table.wglCreateContext.handler([hdc]);
    assert.notEqual(context, 0);
    assert.equal(table.wglGetCurrentContext.handler([]), 0, 'not current merely by existing');
    assert.equal(table.wglMakeCurrent.handler([hdc, context]), 1);
    assert.equal(table.wglGetCurrentContext.handler([]), context);
    assert.equal(table.wglGetCurrentDC.handler([]), hdc);

    table.glClearColor.handler(
        [floatBits(1), floatBits(0), floatBits(0), floatBits(1)]);
    table.glClear.handler([GL.COLOR_BUFFER_BIT]);
    assert.equal(table.wglSwapBuffers.handler([hdc]), 1);

    assert.equal(presented.length, 1);
    const frame = presented[0];
    assert.equal(frame.width, 4);
    assert.equal(frame.height, 4);
    assert.equal(frame.pitch, 16);
    assert.equal(frame.bitCount, 32);
    // BGRX: red is the third byte of the pixel, and the frame the presenter is
    // shown is the one in guest memory rather than a copy that stayed here.
    assert.deepEqual([...box.bytes.subarray(frame.buffer, frame.buffer + 4)],
        [0, 0, 255, 255]);

    assert.equal(table.wglMakeCurrent.handler([hdc, 0]), 1, 'and it can be released');
    assert.equal(table.wglDeleteContext.handler([context]), 1);
    assert.equal(table.wglDeleteContext.handler([context]), 0, 'but only once');
});

test('a context cannot be made for a device context with no pixel format', ()=>{
    // The failure a program hits when it forgets SetPixelFormat. It has to be a
    // failure rather than a default, because the default would be wrong.
    const { table } = library();

    assert.equal(table.wglCreateContext.handler([0x900d]), 0);
    assert.equal(table.wglCreateContext.handler([0]), 0, 'and not for a null one either');
});

/**
 * Gets a context current on a 4x4 drawable, so that the GL half of the table
 * has somewhere to act.
 *
 * @param {any} table
 */
function startDrawing(table){
    const hdc = 0x900d;
    assert.equal(table.wglSetPixelFormat.handler([hdc, 1, 0]), 1);
    const context = table.wglCreateContext.handler([hdc]);
    assert.notEqual(context, 0);
    assert.equal(table.wglMakeCurrent.handler([hdc, context]), 1);
    return context;
}

test('a frame is presented for its window, which holds the screen when it covers it',
    ()=>{
        // A full-screen program's window drawn on by GL: a paint of a window
        // under it put the program's black main window on the screen between
        // two frames, because the frame did not say whose it was. One larger
        // than the screen -- drawn on while the display mode is still the
        // desktop's -- covers it as well, and a paint on a dialog put the
        // desktop between its frames.
        for (const [drawable, expected] of /** @type {[any, [number, boolean]][]} */ ([
            [{ key: 'window:7', window: 7, width: 4, height: 4 }, [7, true]],
            [{ key: 'window:7', window: 7, width: 8, height: 6 }, [7, true]],
            [{ key: 'window:7', window: 7, width: 4, height: 2 }, [7, false]],
            [{ key: 'window:7', window: 7, width: 8, height: 2 }, [7, false]],
            [{ key: 'dc:36877', width: 4, height: 4 }, [0, false]],
        ]))
        {
            const { table, presentedFor } = library({ describeDrawable: ()=>drawable });
            startDrawing(table);
            assert.equal(table.wglSwapBuffers.handler([0x900d]), 1);
            assert.deepEqual(presentedFor, [expected], drawable.key);
        }
    });

test('the default framebuffer follows its window\'s client size, the viewport the program\'s',
    ()=>{
        // SDL makes its context current on the window at the size it was
        // created, then makes the window full-screen at the display's size and
        // sets the viewport to it: the frame stayed the first size, and the
        // scene sat in a corner of it.
        const drawable = { key: 'window:7', window: 7, width: 8, height: 6 };
        const { table, presented, box } = library({ describeDrawable: ()=>drawable });
        startDrawing(table);
        assert.equal(table.wglSwapBuffers.handler([0x900d]), 1);
        drawable.width = 4;
        drawable.height = 2;
        assert.equal(table.wglSwapBuffers.handler([0x900d]), 1,
            'the frame drawn before the resize is shown at its own size');
        table.glClearColor.handler([floatBits(1), floatBits(0), floatBits(0), floatBits(1)]);
        table.glClear.handler([GL.COLOR_BUFFER_BIT]);
        assert.equal(table.wglSwapBuffers.handler([0x900d]), 1);
        assert.deepEqual(presented.map(frame=>[frame.width, frame.height]),
            [[8, 6], [8, 6], [4, 2]]);
        const last = presented[2];
        assert.deepEqual([...box.bytes.subarray(last.buffer + (4 * 2 - 1) * 4,
            last.buffer + 4 * 2 * 4)], [0, 0, 255, 255], 'cleared to its last pixel');
        const viewport = 0x2000;
        table.glGetIntegerv.handler([GL.VIEWPORT, viewport]);
        const view = new DataView(box.bytes.buffer, box.bytes.byteOffset);
        assert.deepEqual([0, 4, 8, 12].map(at=>view.getInt32(viewport + at, true)), [0, 0, 8, 6],
            'the viewport is as the first attachment set it, until the program sets one');
    });

// --- the typed variants and the memory paths ---

/**
 * A 4x4 drawable with a pixel-per-unit projection, through the table.
 *
 * @param {any} table
 */
function pixelProjection(table){
    const [ll, lh] = doubleBits(0);
    const [rl, rh] = doubleBits(4);
    const [nl, nh] = doubleBits(-1);
    const [fl, fh] = doubleBits(1);
    table.glMatrixMode.handler([GL.PROJECTION]);
    table.glLoadIdentity.handler([]);
    table.glOrtho.handler([ll, lh, rl, rh, ll, lh, rl, rh, nl, nh, fl, fh]);
    table.glMatrixMode.handler([GL.MODELVIEW]);
    table.glLoadIdentity.handler([]);
}

test('an integer colour is normalised and an integer vertex is not', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const out = 0x2000;

    table.glColor3ub.handler([255, 128, 0]);
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    const colour = new DataView(box.bytes.buffer, out, 16);
    assert.equal(colour.getFloat32(0, true), 1);
    assert.equal(colour.getFloat32(4, true), Math.fround(128 / 255));
    assert.equal(colour.getFloat32(12, true), 1, 'three components imply an alpha of one');

    // glColor4b: -128 maps to (2 * -128 + 1) / 255, which is below zero.
    table.glColor4b.handler([127, 0x80, 0, 127]);
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    assert.equal(colour.getFloat32(0, true), 1);
    assert.equal(colour.getFloat32(4, true), Math.fround(-255 / 255));

    // glColor3usv reads three shorts.
    box.bytes.set([0xff, 0xff, 0, 0x80, 0, 0], 0x3000);
    table.glColor3usv.handler([0x3000]);
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    assert.equal(colour.getFloat32(0, true), 1);
    assert.equal(colour.getFloat32(4, true), Math.fround(0x8000 / 65535));

    // glVertex3i keeps its integers and glVertex3d reads doubles: a point at
    // (3, 2) -- which covers the pixel whose centre is within half a pixel of
    // it, the third from the left -- and one at (1.5, 1.5), on a 4x4 frame.
    pixelProjection(table);
    table.glColor3f.handler([floatBits(1), floatBits(1), floatBits(1)]);
    table.glBegin.handler([GL.POINTS]);
    table.glVertex3i.handler([3, 2, 0]);
    const [xl, xh] = doubleBits(1.5);
    const [zl, zh] = doubleBits(0);
    table.glVertex3d.handler([xl, xh, xl, xh, zl, zh]);
    table.glEnd.handler([]);
    table.glReadPixels.handler([0, 0, 4, 4, GL.RED, GL.UNSIGNED_BYTE, out]);
    const rows = [0, 1, 2, 3].map(y=>[...box.bytes.subarray(out + y * 4, out + y * 4 + 4)]);
    assert.deepEqual(rows, [
        [0, 0, 0, 0],
        [0, 255, 0, 0],
        [0, 0, 255, 0],
        [0, 0, 0, 0],
    ]);
});

test('a texture is read out of guest memory through the unpack state', ()=>{
    const { table, box } = library();
    startDrawing(table);
    pixelProjection(table);
    // A 2x1 RGB texture: six bytes, one row, so the alignment does not bite.
    box.bytes.set([255, 0, 0, 0, 0, 255], 0x3000);
    const names = 0x3100;
    table.glGenTextures.handler([1, names]);
    table.glBindTexture.handler([GL.TEXTURE_2D, box.bytes[names]]);
    table.glTexImage2D.handler([GL.TEXTURE_2D, 0, GL.RGB, 2, 1, 0, GL.RGB, GL.UNSIGNED_BYTE,
        0x3000]);
    table.glTexParameteri.handler([GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST]);
    table.glTexParameteri.handler([GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST]);
    table.glEnable.handler([GL.TEXTURE_2D]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);

    table.glBegin.handler([GL.QUADS]);
    table.glTexCoord2f.handler([floatBits(0), floatBits(0)]);
    table.glVertex2f.handler([floatBits(0), floatBits(0)]);
    table.glTexCoord2f.handler([floatBits(1), floatBits(0)]);
    table.glVertex2f.handler([floatBits(4), floatBits(0)]);
    table.glTexCoord2f.handler([floatBits(1), floatBits(1)]);
    table.glVertex2f.handler([floatBits(4), floatBits(4)]);
    table.glTexCoord2f.handler([floatBits(0), floatBits(1)]);
    table.glVertex2f.handler([floatBits(0), floatBits(4)]);
    table.glEnd.handler([]);

    // Read back through glReadPixels into guest memory: bottom row first.
    const out = 0x4000;
    table.glReadPixels.handler([0, 0, 4, 1, GL.RGBA, GL.UNSIGNED_BYTE, out]);
    assert.deepEqual([...box.bytes.subarray(out, out + 4)], [255, 0, 0, 255]);
    assert.deepEqual([...box.bytes.subarray(out + 12, out + 16)], [0, 0, 255, 255]);
});

test('glDrawElements and glGetIntegerv cross guest memory both ways', ()=>{
    const { table, box } = library();
    startDrawing(table);
    pixelProjection(table);
    const view = new DataView(box.bytes.buffer);
    [0, 0, 4, 0, 0, 4].forEach((value, i)=>view.setFloat32(0x3000 + i * 4, value, true));
    box.bytes.set([0, 1, 2], 0x3100);
    table.glVertexPointer.handler([2, GL.FLOAT, 0, 0x3000]);
    table.glEnableClientState.handler([GL.VERTEX_ARRAY]);
    table.glColor3f.handler([floatBits(1), floatBits(1), floatBits(1)]);
    table.glDrawElements.handler([GL.TRIANGLES, 3, GL.UNSIGNED_BYTE, 0x3100]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
    const out = 0x4000;
    table.glReadPixels.handler([0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, out]);
    assert.deepEqual([...box.bytes.subarray(out, out + 4)], [255, 255, 255, 255]);

    table.glGetIntegerv.handler([GL.MAX_TEXTURE_UNITS, out]);
    assert.equal(view.getInt32(out, true), 4);
    table.glGetPointerv.handler([GL.VERTEX_ARRAY_POINTER, out]);
    assert.equal(view.getUint32(out, true), 0x3000);
});

test('an integer light colour is normalised and an integer position is not', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    [0x7fffffff, 0, 0, 0x7fffffff].forEach((value, i)=>view.setInt32(0x3000 + i * 4, value, true));
    table.glLightiv.handler([GL.LIGHT0, GL.DIFFUSE, 0x3000]);
    [1, 2, 3, 1].forEach((value, i)=>view.setInt32(0x3000 + i * 4, value, true));
    table.glLightiv.handler([GL.LIGHT0, GL.POSITION, 0x3000]);
    const out = 0x4000;
    table.glGetLightfv.handler([GL.LIGHT0, GL.DIFFUSE, out]);
    assert.equal(view.getFloat32(out, true), 1);
    assert.equal(view.getFloat32(out + 4, true), Math.fround(1 / 4294967295));
    table.glGetLightfv.handler([GL.LIGHT0, GL.POSITION, out]);
    assert.deepEqual([0, 4, 8, 12].map(k=>view.getFloat32(out + k, true)), [1, 2, 3, 1]);
    table.glGetLightiv.handler([GL.LIGHT0, GL.DIFFUSE, out]);
    assert.equal(view.getInt32(out, true), 0x7fffffff, 'and reads back onto the integer range');
});

test('a mapped buffer lives in guest memory the program writes through', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    const names = 0x3000;
    table.glGenBuffersARB.handler([1, names]);
    const name = view.getUint32(names, true);
    assert.ok(name > 0);
    table.glBindBufferARB.handler([GL.ARRAY_BUFFER, name]);
    table.glBufferDataARB.handler([GL.ARRAY_BUFFER, 8, 0, GL.DYNAMIC_DRAW]);
    const address = table.glMapBufferARB.handler([GL.ARRAY_BUFFER, GL.WRITE_ONLY]);
    assert.notEqual(address, 0);
    box.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], address);
    assert.equal(table.glUnmapBufferARB.handler([GL.ARRAY_BUFFER]), 1);
    const out = 0x4000;
    table.glGetBufferSubDataARB.handler([GL.ARRAY_BUFFER, 4, 4, out]);
    assert.deepEqual([...box.bytes.subarray(out, out + 4)], [5, 6, 7, 8]);
    table.glGetBufferParameterivARB.handler([GL.ARRAY_BUFFER, GL.BUFFER_SIZE, out]);
    assert.equal(view.getInt32(out, true), 8);
});

test('WGL_ARB_pixel_format answers attributes and chooses by them', ()=>{
    const { table, box } = library();
    const view = new DataView(box.bytes.buffer);
    const hdc = 0x900d;
    const attributes = 0x3000;
    [WGL.NUMBER_PIXEL_FORMATS_ARB, WGL.COLOR_BITS_ARB, WGL.DOUBLE_BUFFER_ARB]
        .forEach((value, i)=>view.setUint32(attributes + i * 4, value, true));
    const out = 0x4000;
    assert.equal(table.wglGetPixelFormatAttribivARB.handler([hdc, 1, 0, 3, attributes, out]), 1);
    assert.equal(view.getInt32(out, true), PIXEL_FORMATS.length);
    assert.equal(view.getInt32(out + 4, true), PIXEL_FORMATS[0].cColorBits);
    assert.equal(view.getInt32(out + 8, true),
        (PIXEL_FORMATS[0].dwFlags & PFD.DOUBLEBUFFER) ? 1 : 0);
    view.setUint32(attributes, 0xdead, true);
    assert.equal(table.wglGetPixelFormatAttribivARB.handler([hdc, 1, 0, 1, attributes, out]), 0,
        'an unknown attribute fails the whole query');

    const request = 0x3100;
    [WGL.DRAW_TO_WINDOW_ARB, 1, WGL.SUPPORT_OPENGL_ARB, 1, WGL.DOUBLE_BUFFER_ARB, 1,
        WGL.COLOR_BITS_ARB, 32, WGL.DEPTH_BITS_ARB, 24, 0, 0]
        .forEach((value, i)=>view.setInt32(request + i * 4, value, true));
    const formats = 0x4100;
    const count = 0x4200;
    assert.equal(table.wglChoosePixelFormatARB.handler([hdc, request, 0, 1, formats, count]), 1);
    assert.equal(view.getUint32(count, true), 1);
    const chosen = view.getUint32(formats, true);
    assert.ok(chosen >= 1 && chosen <= PIXEL_FORMATS.length);
    assert.ok(PIXEL_FORMATS[chosen - 1].dwFlags & PFD.DOUBLEBUFFER, 'double buffered as asked');
    assert.ok(PIXEL_FORMATS[chosen - 1].cDepthBits >= 24);
});

test('the swap interval is the window\'s: every context on it reads it, no other window does',
    ()=>{
        const { table } = library({ describeDrawable: (/** @type {number} */ hdc)=>({
            key: `window:${hdc}`, width: 4, height: 4, window: hdc }) });
        assert.equal(table.wglSwapIntervalEXT.handler([0]), 0, 'no context is current');
        for (const hdc of [0x900d, 0x900e])
        {
            assert.equal(table.wglSetPixelFormat.handler([hdc, 1, 0]), 1);
        }
        const first = table.wglCreateContext.handler([0x900d]);
        const second = table.wglCreateContext.handler([0x900d]);
        assert.equal(table.wglMakeCurrent.handler([0x900d, first]), 1);
        assert.equal(table.wglGetSwapIntervalEXT.handler([]), 1, 'one by default');
        assert.equal(table.wglSwapIntervalEXT.handler([0]), 1);
        assert.equal(table.wglGetSwapIntervalEXT.handler([]), 0);
        assert.equal(table.wglMakeCurrent.handler([0x900d, second]), 1);
        assert.equal(table.wglGetSwapIntervalEXT.handler([]), 0, 'another context, one window');
        assert.equal(table.wglMakeCurrent.handler([0x900e, first]), 1);
        assert.equal(table.wglGetSwapIntervalEXT.handler([]), 1, 'another window');
        assert.equal(table.wglSwapIntervalEXT.handler([-1]), 0);
    });

test('a vector argument is decoded from the window over guest memory, not from a copy', ()=>{
    // The `*v` entry points read a handful of floats the guest points at --
    // four for a program parameter, sixteen for a matrix -- and consume them
    // before the handler returns, so nothing about them outlives the guest's
    // next instruction. A copy buys nothing there, and a title's frame makes
    // thousands of these: four program parameters and a matrix per draw.
    const box = machine();
    let copies = 0;
    let windows = 0;
    // The window is the graphics module's own service for exactly this (a
    // block read on every call); the library does not take it yet.
    /** @type {any} */
    const services = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
            copies++;
            return box.readMemory(at, length);
        },
        windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
            windows++;
            return box.readMemory(at, length);
        },
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
    };
    const { table } = createOpengl(services);
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    [1.5, -2, 0.25, 8].forEach((value, i)=>view.setFloat32(0x3000 + i * 4, value, true));
    for (let i = 0; i < 16; i++)
    {
        view.setFloat32(0x3100 + i * 4, i + 1, true);
    }
    [0.5, 0.25, 1, 0].forEach((value, i)=>view.setFloat32(0x3200 + i * 4, value, true));
    copies = 0;
    windows = 0;

    table.glProgramEnvParameter4fvARB.handler([GL.VERTEX_PROGRAM_ARB, 3, 0x3000]);
    table.glMatrixMode.handler([GL.MODELVIEW]);
    table.glLoadMatrixf.handler([0x3100]);
    table.glColor4fv.handler([0x3200]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
    assert.equal(copies, 0, 'no vector argument was copied out of guest memory');
    assert.equal(windows, 3, 'each was read through the window, once');

    // And the values arrived whole, which is what the window has to keep true.
    const out = 0x4000;
    table.glGetProgramEnvParameterfvARB.handler([GL.VERTEX_PROGRAM_ARB, 3, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [1.5, -2, 0.25, 8]);
    table.glGetFloatv.handler([GL.MODELVIEW_MATRIX, out]);
    assert.deepEqual([...Array(16).keys()].map(i=>view.getFloat32(out + i * 4, true)),
        [...Array(16).keys()].map(i=>i + 1));
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [0.5, 0.25, 1, 0]);
});

test('two consecutive glProgramEnvParameter4fvARB calls hand the context the same array '
    + 'object, with the second call\'s values, and construct zero DataViews', ()=>{
    // The env-parameter and matrix readers decode into one reused Float32Array
    // scratch per count instead of a fresh array per call; correctness rests
    // on the context copying out of it (`env.set`) before the next call
    // overwrites it, which the readback below proves.
    const box = machine();
    const view = new DataView(box.bytes.buffer);
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        // The memory layer's own reader, decoding straight off the pre-existing
        // view above: no window, no per-call `DataView`, the shape the real
        // accessor takes.
        readF32sInto: (/** @type {number} */ at, /** @type {number} */ count,
            /** @type {Float32Array | number[]} */ into)=>
        {
            for (let i = 0; i < count; i++)
            {
                into[i] = view.getFloat32(at + i * 4, true);
            }
        },
    });
    const table = /** @type {Table} */ (opengl.table);
    startDrawing(table);
    [1.5, -2, 0.25, 8].forEach((value, i)=>view.setFloat32(0x3000 + i * 4, value, true));
    [4, 5, 6, 7].forEach((value, i)=>view.setFloat32(0x3100 + i * 4, value, true));

    const RealSet = Float32Array.prototype.set;
    const RealDataView = globalThis.DataView;
    /** @type {any[]} */
    const setOn = [];
    let dataViews = 0;
    globalThis.DataView = /** @type {any} */ (class extends RealDataView {
        constructor(/** @type {any[]} */ ...args){
            dataViews++;
            super(.../** @type {[ArrayBufferLike, number?, number?]} */ (args));
        }
    });
    Float32Array.prototype.set = /** @type {any} */ (
        function(/** @type {any} */ source, /** @type {number} */ offset){
            setOn.push(source);
            return RealSet.call(this, source, offset);
        });
    try
    {
        table.glProgramEnvParameter4fvARB.handler([GL.VERTEX_PROGRAM_ARB, 0, 0x3000]);
        table.glProgramEnvParameter4fvARB.handler([GL.VERTEX_PROGRAM_ARB, 1, 0x3100]);
    }
    finally
    {
        Float32Array.prototype.set = RealSet;
        globalThis.DataView = RealDataView;
    }

    assert.equal(setOn.length, 2, 'the context copied out of the scratch both times');
    assert.equal(setOn[0], setOn[1], 'the same array object, mutated for the second call');
    assert.equal(dataViews, 0, 'no DataView constructed by either read');

    const out = 0x4000;
    table.glGetProgramEnvParameterfvARB.handler([GL.VERTEX_PROGRAM_ARB, 0, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [1.5, -2, 0.25, 8],
        'the first call\'s own values, not overwritten by the second');
    table.glGetProgramEnvParameterfvARB.handler([GL.VERTEX_PROGRAM_ARB, 1, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [4, 5, 6, 7]);
});

test('glDeleteBuffersARB still answers two independent lists, not a shared scratch', ()=>{
    // readU32s is the variable-count reader glDeleteBuffersARB goes through;
    // this pins that it stayed a fresh array per call while the two
    // fixed-count float readers above moved to a reused one.
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    const namesA = 0x3000;
    const namesB = 0x3100;
    table.glGenBuffersARB.handler([2, namesA]);
    table.glGenBuffersARB.handler([2, namesB]);
    const [a0, a1] = [view.getUint32(namesA, true), view.getUint32(namesA + 4, true)];
    const [b0, b1] = [view.getUint32(namesB, true), view.getUint32(namesB + 4, true)];
    [a0, a1, b0, b1].forEach(name=>table.glBindBufferARB.handler([GL.ARRAY_BUFFER, name]));

    table.glDeleteBuffersARB.handler([2, namesA]);
    assert.equal(table.glIsBufferARB.handler([a0]), GL.FALSE);
    assert.equal(table.glIsBufferARB.handler([a1]), GL.FALSE);
    assert.equal(table.glIsBufferARB.handler([b0]), GL.TRUE, 'the second list is untouched');
    assert.equal(table.glIsBufferARB.handler([b1]), GL.TRUE);

    table.glDeleteBuffersARB.handler([2, namesB]);
    assert.equal(table.glIsBufferARB.handler([b0]), GL.FALSE);
    assert.equal(table.glIsBufferARB.handler([b1]), GL.FALSE);
});

test('entry(name) is the very function the trap table binds, and null for an unknown name', ()=>{
    const { opengl, table } = library();
    assert.equal(opengl.entry('glStencilOp'), table.glStencilOp.handler,
        'same handler, same dwords');
    assert.equal(opengl.entry('glNoSuchThing'), null);
});

test('entry(name), with no current context, answers 0', ()=>{
    const { opengl } = library();
    assert.equal(mustEntry(opengl, 'glEnable')([GL.BLEND]), 0);
});

/** `entry(name)`, asserted non-null: every name used below this line is implemented. */
function mustEntry(/** @type {ReturnType<typeof library>['opengl']} */ opengl, /** @type {string} */ name){
    const found = opengl.entry(name);
    assert.ok(found, `${name} is implemented`);
    return found;
}

/** A device context, format and current context, the way "the whole path" test makes one. */
function contextOn(/** @type {ReturnType<typeof library>} */ lib){
    const hdc = 0x900d;
    const request = 0x1000;
    lib.box.writeMemory(request, encodePixelFormat(/** @type {any} */ ({
        nSize: PIXELFORMATDESCRIPTOR.SIZE,
        nVersion: 1,
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER,
        iPixelType: PFD.TYPE_RGBA,
        cColorBits: 32,
        cDepthBits: 16,
        cStencilBits: 0,
        cAlphaBits: 0,
        cAccumBits: 0,
        cAuxBuffers: 0,
        iLayerType: PFD.MAIN_PLANE,
    })));
    const format = lib.table.wglChoosePixelFormat.handler([hdc, request]);
    lib.table.wglSetPixelFormat.handler([hdc, format, request]);
    const context = lib.table.wglCreateContext.handler([hdc]);
    lib.table.wglMakeCurrent.handler([hdc, context]);
    return hdc;
}

test('through entry, the same two calls leave the framebuffer the table path leaves it', ()=>{
    const byEntry = library();
    const hdc1 = contextOn(byEntry);
    mustEntry(byEntry.opengl, 'glClearColor')(
        [floatBits(0.5), 0, 0, floatBits(1)]);
    mustEntry(byEntry.opengl, 'glClear')([GL.COLOR_BUFFER_BIT]);
    byEntry.table.wglSwapBuffers.handler([hdc1]);

    const byTable = library();
    const hdc2 = contextOn(byTable);
    byTable.table.glClearColor.handler(
        [floatBits(0.5), 0, 0, floatBits(1)]);
    byTable.table.glClear.handler([GL.COLOR_BUFFER_BIT]);
    byTable.table.wglSwapBuffers.handler([hdc2]);

    assert.equal(byEntry.presented.length, 1);
    assert.equal(byTable.presented.length, 1);
    const pixel = (/** @type {any} */ lib)=>[...lib.box.bytes.subarray(
        lib.presented[0].buffer, lib.presented[0].buffer + 4)];
    assert.deepEqual(pixel(byEntry), pixel(byTable));
});

test('raster: false reaches the library\'s contexts: a triangle over a clear paints nothing',
    ()=>{
        /** @param {boolean | undefined} raster @returns {number[]} */
        const drawn = raster=>{
            const lib = library({ raster });
            const hdc = contextOn(lib);
            lib.table.glClearColor.handler([0, 0, floatBits(1), floatBits(1)]);
            lib.table.glClear.handler([GL.COLOR_BUFFER_BIT]);
            lib.table.glColor3f.handler([floatBits(1), 0, 0]);
            lib.table.glBegin.handler([GL.TRIANGLES]);
            lib.table.glVertex2f.handler([floatBits(-1), floatBits(-1)]);
            lib.table.glVertex2f.handler([floatBits(3), floatBits(-1)]);
            lib.table.glVertex2f.handler([floatBits(-1), floatBits(3)]);
            lib.table.glEnd.handler([]);
            lib.table.wglSwapBuffers.handler([hdc]);
            const frame = lib.presented[0];
            return [...lib.box.bytes.subarray(frame.buffer, frame.buffer + 4)];
        };
        assert.deepEqual(drawn(undefined), [0, 0, 255, 255], 'rasterised: red, in BGRX');
        assert.deepEqual(drawn(false), [255, 0, 0, 255], 'not rasterised: the clear\'s blue');
    });

test('every typed form hands the context what its type decodes to, through the memory layer\'s '
    + 'reader or a window alike, and makes no view of its own per call', ()=>{
    // The immediate and `*v` forms of each family decode their components in
    // a handler bound once per name; the float vectors go through the memory
    // layer's reader where there is one and every other vector through a
    // window into scratch. Each form is checked against the specification's
    // decoding -- the integer types normalised where the family is a colour
    // or a normal, a form short of four components filled with (0, 0, 1) --
    // in a library with the reader and in one without.
    /**
     * @type {Record<string, { bytes: number, put: (view: DataView, at: number, x: number)
     *     => void, word: (x: number) => number[], norm: (x: number) => number }>}
     */
    const TYPE = {
        f: { bytes: 4, put: (v, at, x)=>v.setFloat32(at, x, true), word: x=>[floatBits(x)],
            norm: x=>x },
        d: { bytes: 8, put: (v, at, x)=>v.setFloat64(at, x, true), word: x=>doubleBits(x),
            norm: x=>x },
        b: { bytes: 1, put: (v, at, x)=>v.setInt8(at, x), word: x=>[x | 0],
            norm: x=>(2 * x + 1) / 255 },
        ub: { bytes: 1, put: (v, at, x)=>v.setUint8(at, x), word: x=>[x],
            norm: x=>x / 255 },
        s: { bytes: 2, put: (v, at, x)=>v.setInt16(at, x, true), word: x=>[x | 0],
            norm: x=>(2 * x + 1) / 65535 },
        us: { bytes: 2, put: (v, at, x)=>v.setUint16(at, x, true), word: x=>[x],
            norm: x=>x / 65535 },
        i: { bytes: 4, put: (v, at, x)=>v.setInt32(at, x, true), word: x=>[x | 0],
            norm: x=>(2 * x + 1) / 4294967295 },
        ui: { bytes: 4, put: (v, at, x)=>v.setUint32(at, x, true), word: x=>[x >>> 0],
            norm: x=>x / 4294967295 },
    };
    /** Four values of each type, none of them a default. */
    /** @type {Record<string, number[]>} */
    const SAMPLE = {
        f: [0.5, -2, 0.25, 8], d: [1.5, -0.75, 3, 0.125], b: [100, -7, 3, -128],
        ub: [200, 7, 255, 1], s: [-300, 1200, 5, 32767], us: [65535, 3, 40000, 12],
        i: [70000, -5, 123456, 9], ui: [4000000000, 5, 77, 300000],
    };
    const floatOf = (/** @type {number} */ x)=>Math.fround(x);

    for (const withReader of [true, false])
    {
        const box = machine();
        const view = new DataView(box.bytes.buffer);
        let windows = 0;
        const opengl = createOpengl({
            readMemory: box.readMemory,
            windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
                windows++;
                return box.readMemory(at, length);
            },
            writeMemory: box.writeMemory,
            screen: ()=>({ width: 4, height: 4 }),
            scratch: box.scratch,
            ...(withReader ? {
                readF32sInto: (/** @type {number} */ at, /** @type {number} */ count,
                    /** @type {Float32Array | number[]} */ into)=>
                {
                    for (let i = 0; i < count; i++)
                    {
                        into[i] = view.getFloat32(at + i * 4, true);
                    }
                },
            } : {}),
        });
        const table = /** @type {Table} */ (opengl.table);
        startDrawing(table);
        const vector = 0x3000;
        const out = 0x4000;

        /**
         * One form, immediate and vector, against what the query reads back.
         *
         * @param {string} name  the immediate form's name
         * @param {string} vectorName
         * @param {number[]} lead  the words before the components
         * @param {string} type
         * @param {number} count
         * @param {number[]} expected  what the query answers, before float rounding
         * @param {() => number[]} query
         * @param {string} label
         */
        const check = (name, vectorName, lead, type, count, expected, query, label)=>{
            const t = TYPE[type];
            const values = SAMPLE[type].slice(0, count);
            table[name].handler([...lead, ...values.flatMap(t.word)]);
            assert.deepEqual(query(), expected.map(floatOf), `${label} ${name}`);
            // Something else in between, so the vector form has to set it.
            table[name].handler([...lead, ...SAMPLE.f.slice(0, count).flatMap(x=>
                TYPE[type].word(type === 'f' || type === 'd' ? x + 1 : 1))]);
            values.forEach((x, i)=>t.put(view, vector + i * t.bytes, x));
            const readsBefore = windows;
            table[vectorName].handler([...lead, vector]);
            assert.deepEqual(query(), expected.map(floatOf), `${label} ${vectorName}`);
            assert.equal(windows - readsBefore, withReader && type === 'f' ? 0 : 1,
                `${label} ${vectorName}: one window, or none where the reader reads floats`);
        };
        /** @param {number} query @param {number} count */
        const floats = (query, count)=>{
            table.glGetFloatv.handler([query, out]);
            return [...Array(count).keys()].map(i=>view.getFloat32(out + i * 4, true));
        };
        const label = withReader ? 'with the reader:' : 'through a window:';

        for (const type of ['b', 'd', 'f', 'i', 's', 'ub', 'ui', 'us'])
        {
            const norm = TYPE[type].norm;
            const [x, y, z, w] = SAMPLE[type];
            check(`glColor3${type}`, `glColor3${type}v`, [], type, 3,
                [norm(x), norm(y), norm(z), 1], ()=>floats(GL.CURRENT_COLOR, 4), label);
            check(`glColor4${type}`, `glColor4${type}v`, [], type, 4,
                [norm(x), norm(y), norm(z), norm(w)], ()=>floats(GL.CURRENT_COLOR, 4), label);
            check(`glSecondaryColor3${type}EXT`, `glSecondaryColor3${type}vEXT`, [], type, 3,
                [norm(x), norm(y), norm(z)], ()=>floats(GL.CURRENT_SECONDARY_COLOR, 3), label);
        }
        for (const type of ['b', 'd', 'f', 'i', 's'])
        {
            const norm = TYPE[type].norm;
            const [x, y, z] = SAMPLE[type];
            check(`glNormal3${type}`, `glNormal3${type}v`, [], type, 3,
                [norm(x), norm(y), norm(z)], ()=>floats(GL.CURRENT_NORMAL, 3), label);
        }
        for (const type of ['d', 'f', 'i', 's'])
        {
            for (const count of [1, 2, 3, 4])
            {
                const expected = [...SAMPLE[type].slice(0, count), 0, 0, 1].slice(0, 4);
                if (count < 4)
                {
                    expected[3] = 1;
                }
                check(`glTexCoord${count}${type}`, `glTexCoord${count}${type}v`, [], type, count,
                    expected, ()=>floats(GL.CURRENT_TEXTURE_COORDS, 4), label);
                check(`glMultiTexCoord${count}${type}ARB`, `glMultiTexCoord${count}${type}vARB`,
                    [GL.TEXTURE0 + 1], type, count, expected, ()=>{
                        table.glActiveTextureARB.handler([GL.TEXTURE0 + 1]);
                        const answer = floats(GL.CURRENT_TEXTURE_COORDS, 4);
                        table.glActiveTextureARB.handler([GL.TEXTURE0]);
                        return answer;
                    }, label);
            }
        }
        /** @param {number} index */
        const attribute = index=>{
            table.glGetVertexAttribfvARB.handler([index, GL.CURRENT_VERTEX_ATTRIB_ARB, out]);
            return [0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true));
        };
        for (const type of ['d', 'f', 's'])
        {
            for (const count of [1, 2, 3, 4])
            {
                const expected = [...SAMPLE[type].slice(0, count), 0, 0, 1].slice(0, 4);
                if (count < 4)
                {
                    expected[3] = 1;
                }
                check(`glVertexAttrib${count}${type}ARB`, `glVertexAttrib${count}${type}vARB`,
                    [5], type, count, expected, ()=>attribute(5), label);
            }
        }
        for (const [suffix, type, normalised] of /** @type {[string, string, boolean][]} */ ([
            ['4bv', 'b', false], ['4ubv', 'ub', false], ['4usv', 'us', false],
            ['4Nbv', 'b', true], ['4Nubv', 'ub', true], ['4Nsv', 's', true],
            ['4Nuiv', 'ui', true], ['4dv', 'd', false], ['4fv', 'f', false]]))
        {
            const convert = normalised ? TYPE[type].norm : (/** @type {number} */ x)=>x;
            const t = TYPE[type];
            SAMPLE[type].forEach((x, i)=>t.put(view, vector + i * t.bytes, x));
            table[`glVertexAttrib${suffix}ARB`].handler([6, vector]);
            assert.deepEqual(attribute(6), SAMPLE[type].map(convert).map(floatOf),
                `${label} glVertexAttrib${suffix}ARB`);
        }
    }
});

test('a typed vector form makes no DataView of its own on a call', ()=>{
    const box = machine();
    const view = new DataView(box.bytes.buffer);
    const { table } = createOpengl({
        readMemory: box.readMemory,
        windowMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        readF32sInto: (/** @type {number} */ at, /** @type {number} */ count,
            /** @type {Float32Array | number[]} */ into)=>
        {
            for (let i = 0; i < count; i++)
            {
                into[i] = view.getFloat32(at + i * 4, true);
            }
        },
    });
    startDrawing(table);
    box.bytes.set([10, 20, 30, 40], 0x3000);
    [0.5, 0.25, 1, 0].forEach((value, i)=>view.setFloat32(0x3100 + i * 4, value, true));
    const RealDataView = globalThis.DataView;
    let dataViews = 0;
    globalThis.DataView = /** @type {any} */ (class extends RealDataView {
        constructor(/** @type {any[]} */ ...args){
            dataViews++;
            super(.../** @type {[ArrayBufferLike, number?, number?]} */ (args));
        }
    });
    try
    {
        table.glColor4ubv.handler([0x3000]);
        table.glColor4fv.handler([0x3100]);
        table.glVertexAttrib4NubvARB.handler([2, 0x3000]);
        table.glTexCoord2fv.handler([0x3100]);
    }
    finally
    {
        globalThis.DataView = RealDataView;
    }
    assert.equal(dataViews, 0);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
});

test('with no context current glGetError answers GL_INVALID_OPERATION and glGetString NULL', ()=>{
    // Wine's opengl32 test, before its first context is made.
    const { table } = library();
    assert.equal(table.glGetError.handler([]), GL.INVALID_OPERATION);
    assert.equal(table.glGetString.handler([GL.VERSION]), 0);
});

test('a WGL refusal reaches the program\'s GetLastError', ()=>{
    // wglCreateContext on a DC no pixel format was set on: the error is the
    // program's to read, not only the library's.
    /** @type {number[]} */
    const errors = [];
    const box = machine();
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        describeDrawable: (/** @type {number} */ hdc)=>({ key: `dc:${hdc}`, width: 4, height: 4 }),
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    });
    const table = /** @type {Table} */ (opengl.table);
    assert.equal(table.wglCreateContext.handler([0x1234]), 0);
    assert.deepEqual(errors, [2000], 'ERROR_INVALID_PIXEL_FORMAT');
});

test('a context handle deleted or never made is ERROR_INVALID_HANDLE to delete or bind', ()=>{
    /** @type {number[]} */
    const errors = [];
    const box = machine();
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    });
    const table = /** @type {Table} */ (opengl.table);
    assert.equal(table.wglDeleteContext.handler([0x4321]), 0);
    assert.equal(table.wglMakeCurrent.handler([0, 0x4321]), 0);
    assert.deepEqual(errors, [6, 6]);
});

test('every export\'s floats and doubles are where its prototype puts them, in its words', ()=>{
    // A 64-bit caller passes them in XMM registers and a double in one slot,
    // so the bridge is told which words they are; each declaration is checked
    // against the export's word count as it is made.
    const names = Object.values(ARGUMENT_WORDS).flat();
    /** @type {string[]} */
    const typed = [];
    for (const name of names)
    {
        const floats = floatArguments(name);
        if (floats)
        {
            typed.push(name);
        }
        // A name that reads as taking floats and declares none is one of
        // the matrix calls, whose argument is a pointer -- or one the
        // registry declares, whose letters say what it takes.
        else if (/[fd](ARB|EXT)?$/.test(name) && !/v(ARB|EXT)?$/.test(name)
            && registryArguments(name) === undefined)
        {
            assert.match(name, /^gl(Load|Mult)(Transpose)?Matrix[fd]$|^gl(End|IsEnabled)$/,
                name);
        }
    }
    assert.ok(typed.length > 90, `${typed.length} exports declare floats`);
    assert.deepEqual(floatArguments('glClearColor'), { 0: 'f32', 1: 'f32', 2: 'f32', 3: 'f32' });
    assert.deepEqual(floatArguments('glOrtho'),
        { 0: 'f64', 2: 'f64', 4: 'f64', 6: 'f64', 8: 'f64', 10: 'f64' });
    assert.deepEqual(floatArguments('glMultiTexCoord2dARB'), { 1: 'f64', 3: 'f64' },
        'a family: the target, then two doubles');
    assert.deepEqual(floatArguments('glBitmap'), { 2: 'f32', 3: 'f32', 4: 'f32', 5: 'f32' });
    assert.equal(floatArguments('glVertex3i'), null);
    assert.equal(floatArguments('glLoadMatrixf'), null, 'a pointer to floats is a pointer');
    assert.deepEqual(floatArguments('glUniform3f'), { 1: 'f32', 2: 'f32', 3: 'f32' },
        'a uniform: the location, then the values');
    assert.equal(floatArguments('glUniform4i'), null);
    assert.equal(floatArguments('glUniformMatrix4fv'), null);
    assert.deepEqual(floatArguments('glBlendColor'), { 0: 'f32', 1: 'f32', 2: 'f32', 3: 'f32' });
    assert.deepEqual(floatArguments('glSampleCoverage'), { 0: 'f32' });
});

test('glCallLists reads GL_2_BYTES, GL_3_BYTES and GL_4_BYTES names two to four bytes wide,'
    + ' the first byte highest', ()=>{
    assert.deepEqual([GL.TWO_BYTES, GL.THREE_BYTES, GL.FOUR_BYTES, GL.FLOAT].map(byteRunWidth),
        [2, 3, 4, 0]);
    const bytes = Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05, 0x06);
    assert.deepEqual(byteRunNames(bytes, 2, 3), [0x0102, 0x0304, 0x0506]);
    assert.deepEqual(byteRunNames(bytes, 3, 2), [0x010203, 0x040506]);
    assert.deepEqual(byteRunNames(bytes.subarray(0, 4), 4, 1), [0x01020304]);
});

test('wglCreateContextAttribsARB refuses what WGL_ARB_create_context refuses and makes the rest',
    ()=>{
        /** @type {number[]} */
        const errors = [];
        const box = machine();
        const opengl = createOpengl({
            readMemory: box.readMemory,
            writeMemory: box.writeMemory,
            screen: ()=>({ width: 4, height: 4 }),
            scratch: box.scratch,
            describeDrawable: (/** @type {number} */ hdc)=>(hdc === 0x900d
                ? { key: `dc:${hdc}`, width: 4, height: 4 } : null),
            setLastError: (/** @type {number} */ code)=>errors.push(code),
        });
        const table = /** @type {Table} */ (opengl.table);
        /** @param {number} at @param {number[]} words */
        const put = (at, words)=>box.writeMemory(at,
            new Uint8Array(Uint32Array.from(words).buffer));
        const create = (/** @type {number} */ hdc, /** @type {number} */ share,
            /** @type {number} */ list)=>table.wglCreateContextAttribsARB.handler([hdc, share, list]);
        assert.equal(table.wglSetPixelFormat.handler([0x900d, 1, 0]), 1);

        assert.equal(create(0xdeadbeef, 0, 0), 0);
        assert.equal(create(0x900d, 0xdeadbeef, 0), 0);
        put(0x2000, [0x2099, 1, 0]);
        assert.equal(create(0x900d, 0, 0x2000), 0);
        put(0x2000, [0x2091, 4, 0x2092, 6, 0]);
        assert.equal(create(0x900d, 0, 0x2000), 0, 'a version past this implementation\'s');
        assert.deepEqual(errors, [6, 4317, 87, 0x2095]);

        // An earlier version: this implementation's, and the share list taken.
        const first = create(0x900d, 0, 0);
        assert.notEqual(first, 0);
        put(0x2000, [0x2091, 2, 0x2092, 0, 0x2094, 1, 0]);
        const second = create(0x900d, first, 0x2000);
        assert.notEqual(second, 0);
        assert.equal(table.wglMakeCurrent.handler([0x900d, second]), 1);
        const shared = opengl.withContext((/** @type {any} */ context)=>{
            context.glNewList(1, GL.COMPILE);
            context.glEndList();
            return context.version;
        });
        assert.deepEqual(shared, { major: 2, minor: 1,
            profile: GL.CONTEXT_COMPATIBILITY_PROFILE_BIT, flags: GL.CONTEXT_FLAG_DEBUG_BIT });
        assert.equal(table.wglMakeCurrent.handler([0x900d, first]), 1);
        assert.equal(opengl.withContext((/** @type {any} */ context)=>context.glIsList(1)),
            GL.TRUE, 'the two share their lists');
    });

test('wglMakeContextCurrentARB reads from its second DC, which must carry the context\'s format',
    ()=>{
        /** @type {number[]} */
        const errors = [];
        const box = machine();
        const opengl = createOpengl({
            readMemory: box.readMemory,
            writeMemory: box.writeMemory,
            screen: ()=>({ width: 4, height: 4 }),
            scratch: box.scratch,
            describeDrawable: (/** @type {number} */ hdc)=>({ key: `window:${hdc}`,
                width: 4, height: 4, window: hdc }),
            setLastError: (/** @type {number} */ code)=>errors.push(code),
        });
        const table = /** @type {Table} */ (opengl.table);
        const [draw, read, other] = [0x900d, 0x900e, 0x900f];
        assert.equal(table.wglSetPixelFormat.handler([draw, 1, 0]), 1);
        assert.equal(table.wglSetPixelFormat.handler([read, 1, 0]), 1);
        assert.equal(table.wglSetPixelFormat.handler([other, 2, 0]), 1);
        const context = table.wglCreateContext.handler([draw]);
        assert.equal(table.wglMakeContextCurrentARB.handler([draw, other, context]), 0);
        assert.deepEqual(errors, [2000], 'ERROR_INVALID_PIXEL_FORMAT: the read DC\'s format');
        assert.equal(table.wglMakeContextCurrentARB.handler([draw, read, context]), 1);
        assert.equal(table.wglGetCurrentDC.handler([]), draw);
        assert.equal(table.wglGetCurrentReadDCARB.handler([]), read);
        assert.equal(table.wglMakeCurrent.handler([draw, context]), 1);
        assert.equal(table.wglGetCurrentReadDCARB.handler([]), draw, 'one DC both ways');
        assert.equal(table.wglMakeContextCurrentARB.handler([draw, draw, 0]), 1);
        assert.equal(table.wglGetCurrentReadDCARB.handler([]), 0);
    });

/** @param {{ errors: number[] }} [log] */
function pbufferLibrary(log = { errors: [] }){
    const box = machine();
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        describeDrawable: (/** @type {number} */ hdc)=>(hdc === 0x900d
            ? { key: 'window:1', width: 200, height: 200, window: 1 } : null),
        setLastError: (/** @type {number} */ code)=>log.errors.push(code),
    });
    const table = /** @type {Table} */ (opengl.table);
    /** @param {number[]} words @returns {number} where they were put */
    const list = words=>{
        const at = box.scratch.allocate(words.length * 4);
        box.writeMemory(at, new Uint8Array(Uint32Array.from(words).buffer));
        return at;
    };
    const out = box.scratch.allocate(4);
    /** @param {number} pbuffer @param {number} attribute */
    const query = (pbuffer, attribute)=>(table.wglQueryPbufferARB.handler(
        [pbuffer, attribute, out]) === 1 ? new DataView(box.bytes.buffer).getUint32(out, true)
        : null);
    assert.equal(table.wglSetPixelFormat.handler([0x900d, 1, 0]), 1);
    return { opengl, table, list, query, errors: log.errors };
}

test('WGL_ARB_pbuffer: a pbuffer, its one DC, its attributes, and the refusals', ()=>{
    const { table, list, query, errors } = pbufferLibrary();
    const none = list([0]);
    const create = (/** @type {number[]} */ args)=>table.wglCreatePbufferARB.handler(args);
    assert.equal(create([0x900d, 0, 100, 100, none]), 0);
    assert.equal(create([0x900d, 1, 0, 100, none]), 0);
    assert.equal(create([0x900d, 1, 100, -1, none]), 0);
    assert.equal(create([0x900d, 1, 65535, 65535, none]), 0);
    // The generic renderer's formats draw no pbuffer.
    const generic = PIXEL_FORMATS.findIndex(format=>(format.dwFlags & PFD.GENERIC_FORMAT) !== 0);
    assert.equal(create([0x900d, generic + 1, 16, 16, none]), 0);
    assert.deepEqual(errors, [2000, 13, 13, 1450, 2000],
        'ERROR_INVALID_PIXEL_FORMAT, _INVALID_DATA twice, _NO_SYSTEM_RESOURCES, the format');
    errors.length = 0;

    const largest = create([0x900d, 1, 65535, 65535, list([WGL.PBUFFER_LARGEST_ARB, 1, 0])]);
    assert.notEqual(largest, 0, 'the largest there is, when the program takes it');
    assert.equal(query(largest, WGL.PBUFFER_WIDTH_ARB), 8192);
    assert.equal(table.wglDestroyPbufferARB.handler([largest]), 1);

    const pbuffer = create([0x900d, 1, 16, 8, list([WGL.TEXTURE_FORMAT_ARB,
        WGL.TEXTURE_RGB_ARB, WGL.TEXTURE_TARGET_ARB, WGL.TEXTURE_2D_ARB, 0])]);
    const dc = table.wglGetPbufferDCARB.handler([pbuffer]);
    assert.notEqual(dc, 0);
    assert.equal(table.wglGetPbufferDCARB.handler([pbuffer]), dc, 'the same DC every time');
    assert.equal(table.wglGetPixelFormat.handler([dc]), 1, 'the pbuffer\'s format');
    assert.equal(table.wglReleasePbufferDCARB.handler([pbuffer, 0x900d]), 0);
    assert.deepEqual(errors, [1425], 'ERROR_DC_NOT_FOUND for a DC not its');
    assert.equal(table.wglReleasePbufferDCARB.handler([pbuffer, dc]), 1);
    assert.equal(table.wglReleasePbufferDCARB.handler([pbuffer, dc]), 1, 'and again');
    assert.deepEqual([WGL.PBUFFER_WIDTH_ARB, WGL.PBUFFER_HEIGHT_ARB, WGL.PBUFFER_LOST_ARB,
        WGL.TEXTURE_FORMAT_ARB, WGL.TEXTURE_TARGET_ARB, WGL.MIPMAP_TEXTURE_ARB,
        WGL.MIPMAP_LEVEL_ARB, WGL.CUBE_MAP_FACE_ARB].map(name=>query(pbuffer, name)),
    [16, 8, 0, WGL.TEXTURE_RGB_ARB, WGL.TEXTURE_2D_ARB, 0, 0,
        WGL.TEXTURE_CUBE_MAP_POSITIVE_X_ARB]);
    errors.length = 0;
    assert.equal(query(pbuffer, 0xdeadbeef), null);
    assert.equal(query(0, WGL.PBUFFER_WIDTH_ARB), null);
    assert.equal(table.wglSetPbufferAttribARB.handler([pbuffer, list([WGL.MIPMAP_LEVEL_ARB, 1,
        0])]), 0, 'a level it does not have');
    assert.equal(table.wglSetPbufferAttribARB.handler([pbuffer, list([WGL.CUBE_MAP_FACE_ARB,
        WGL.TEXTURE_CUBE_MAP_POSITIVE_X_ARB, 0])]), 1, 'what it has, taken');
    assert.deepEqual(errors, [13, 6, 13]);
    assert.equal(table.wglDestroyPbufferARB.handler([pbuffer]), 1);
    assert.equal(table.wglDestroyPbufferARB.handler([pbuffer]), 0, 'gone');
    assert.equal(table.wglGetPixelFormat.handler([dc]), 0, 'and its DC with it');
});

test('WGL_ARB_render_texture: the pbuffer is the image of the texture bound until let go of',
    async()=>{
        const { opengl, table, list } = pbufferLibrary();
        const pbuffer = table.wglCreatePbufferARB.handler([0x900d, 1, 16, 8, list([
            WGL.TEXTURE_FORMAT_ARB, WGL.TEXTURE_RGBA_ARB, WGL.TEXTURE_TARGET_ARB,
            WGL.TEXTURE_2D_ARB, 0])]);
        table.wglGetPbufferDCARB.handler([pbuffer]);
        const context = table.wglCreateContext.handler([0x900d]);
        assert.equal(table.wglMakeCurrent.handler([0x900d, context]), 1);
        /** @returns {number[]} the bound 2D texture's level 0, width and height */
        const level = ()=>/** @type {number[]} */ (opengl.withContext((/** @type {any} */ gl)=>[
            gl.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_WIDTH)[0],
            gl.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_HEIGHT)[0]]));
        const bind = (/** @type {number} */ buffer)=>table.wglBindTexImageARB.handler(
            [pbuffer, buffer]);
        const release = (/** @type {number} */ buffer)=>table.wglReleaseTexImageARB.handler(
            [pbuffer, buffer]);
        assert.equal(await bind(GL.BACK), 0, 'GL\'s names are not WGL\'s');
        assert.equal(release(WGL.BACK_LEFT_ARB), 0, 'a single-buffered pbuffer has no back');
        assert.equal(release(WGL.FRONT_LEFT_ARB), 1, 'nothing bound to let go of');
        assert.equal(await bind(WGL.FRONT_LEFT_ARB), 1);
        assert.deepEqual(level(), [16, 8]);
        assert.equal(await bind(WGL.FRONT_LEFT_ARB), 0, 'bound already');
        assert.equal(release(WGL.FRONT_LEFT_ARB), 1);
        assert.deepEqual(level(), [0, 0], 'let go of, the image is none');
        assert.equal(await bind(WGL.FRONT_RIGHT_ARB), 1);
        assert.deepEqual(level(), [0, 0], 'no stereo: the right buffer is none');
        assert.equal(release(WGL.FRONT_RIGHT_ARB), 1);
    });

test('OpenGL ES 2.0\'s calls take floats and write their precisions to guest memory', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    table.glDepthRangef.handler([floatBits(0.25), floatBits(0.75)]);
    table.glClearDepthf.handler([floatBits(0.5)]);
    const out = 0x4000;
    table.glGetFloatv.handler([GL.DEPTH_RANGE, out]);
    assert.deepEqual([view.getFloat32(out, true), view.getFloat32(out + 4, true)], [0.25, 0.75]);
    table.glGetFloatv.handler([GL.DEPTH_CLEAR_VALUE, out]);
    assert.equal(view.getFloat32(out, true), 0.5);
    table.glGetShaderPrecisionFormat.handler([GL.FRAGMENT_SHADER, GL.HIGH_FLOAT, out, out + 8]);
    assert.deepEqual([view.getInt32(out, true), view.getInt32(out + 4, true),
        view.getInt32(out + 8, true)], [127, 127, 23]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
});

test('the indexed viewport calls take floats and doubles, and answer them', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    table.glViewportIndexedf.handler([2, floatBits(1), floatBits(2), floatBits(3),
        floatBits(4)]);
    const out = 0x4000;
    table.glGetFloati_v.handler([GL.VIEWPORT, 2, out]);
    assert.deepEqual([0, 4, 8, 12].map(at=>view.getFloat32(out + at, true)), [1, 2, 3, 4]);
    table.glDepthRangeIndexed.handler([1, ...doubleBits(0.25), ...doubleBits(0.75)]);
    table.glGetDoublei_v.handler([GL.DEPTH_RANGE, 1, out]);
    assert.deepEqual([view.getFloat64(out, true), view.getFloat64(out + 8, true)], [0.25, 0.75]);
    [5, 6, 7, 8].forEach((v, i)=>view.setInt32(0x3000 + i * 4, v, true));
    table.glScissorIndexedv.handler([3, 0x3000]);
    table.glGetIntegeri_v.handler([GL.SCISSOR_BOX, 3, out]);
    assert.deepEqual([0, 4, 8, 12].map(at=>view.getInt32(out + at, true)), [5, 6, 7, 8]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
});

test('glBindVertexBuffers reads its names, offsets and strides from guest memory, and the'
    + ' named calls reach the object', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    table.glGenBuffersARB.handler([2, 0x3000]);
    const names = [view.getUint32(0x3000, true), view.getUint32(0x3004, true)];
    [8, 12].forEach((v, i)=>view.setInt32(0x3100 + i * 4, v, true));
    [16, 20].forEach((v, i)=>view.setInt32(0x3200 + i * 4, v, true));
    table.glBindVertexBuffers.handler([4, 2, 0x3000, 0x3100, 0x3200]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
    const out = 0x4000;
    table.glGetIntegeri_v.handler([GL.VERTEX_BINDING_OFFSET, 5, out]);
    assert.equal(view.getInt32(out, true), 12);
    table.glGetIntegeri_v.handler([GL.VERTEX_BINDING_STRIDE, 4, out]);
    assert.equal(view.getInt32(out, true), 16);
    table.glGetIntegeri_v.handler([GL.VERTEX_BINDING_BUFFER, 5, out]);
    assert.equal(view.getInt32(out, true), names[1]);

    table.glCreateVertexArrays.handler([1, 0x3300]);
    const vao = view.getUint32(0x3300, true);
    table.glVertexArrayVertexBuffer.handler([vao, 2, names[0], 24, 32]);
    table.glGetVertexArrayIndexed64iv.handler([vao, 2, GL.VERTEX_BINDING_OFFSET, out]);
    assert.equal(view.getInt32(out, true), 24);
    table.glGetIntegeri_v.handler([GL.VERTEX_BINDING_OFFSET, 2, out]);
    assert.equal(view.getInt32(out, true), 0, 'the default object untouched');
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
});
